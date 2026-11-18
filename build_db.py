"""Build the indexed SQLite database (tanakh.db) for the Tanakh Search & Graph Explorer.

Reuses the MorphHB + HebrewLexicon dataset cache and linguistic resolver from
build_concordance.py, extracting every verse's vocalized and cantillated tokens,
inter-word separators (maqqef, paseq, sof pasuq), canonical references, and
morphological entries into C:\\robi\\tanakh-concordance\\tanakh.db.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import unicodedata
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

from build_concordance import (
    BASE_DIR,
    CACHE_DIR,
    FINAL_TO_MEDIAL,
    NS_OSIS,
    O_NOTE,
    O_SEG,
    O_W,
    TANAKH_BOOKS,
    WLC_DIR,
    LexiconResolver,
    _find_qere_rdg,
    consonantal_sort_key,
    ensure_datasets,
    normalize_vocalized_word,
    to_gematria,
)

DB_PATH = BASE_DIR / "tanakh.db"
TMP_DB_PATH = BASE_DIR / "tanakh.db.tmp"

BINYAN_BASE_TO_GROUP: Dict[str, str] = {
    unicodedata.normalize("NFC", "פָּעַל"): "paal",
    unicodedata.normalize("NFC", "נִפְעַל"): "nifal",
    unicodedata.normalize("NFC", "פִּעֵל"): "piel",
    unicodedata.normalize("NFC", "פֻּעַל"): "pual",
    unicodedata.normalize("NFC", "הִפְעִיל"): "hifil",
    unicodedata.normalize("NFC", "הֻפְעַל"): "hufal",
    unicodedata.normalize("NFC", "הִתְפַּעֵל"): "hitpael",
    "-": "none",
}


def get_book_division(book_id: int) -> str:
    if book_id <= 5:
        return "תורה"
    if book_id <= 26:
        return "נביאים"
    return "כתובים"


def normalize_cantillated_word(raw_text: str) -> str:
    """Keep Hebrew letters, vowels, cantillation marks, dagesh, meteg, rafe, shin/sin."""
    chars: List[str] = []
    for ch in raw_text:
        if ch in ("/", "+") or ch.isspace():
            continue
        code = ord(ch)
        if (
            0x0591 <= code <= 0x05BD
            or code in (0x05BF, 0x05C1, 0x05C2, 0x05C7)
            or 0x05D0 <= code <= 0x05EA
        ):
            chars.append(ch)
    return unicodedata.normalize("NFC", "".join(chars))


def strip_to_consonants(word: str) -> str:
    """Extract Hebrew consonant letters only (preserving final letters)."""
    return "".join(ch for ch in word if "\u05D0" <= ch <= "\u05EA")


def extract_verse_tokens_with_seps(
    verse_el: ET.Element,
) -> List[Tuple[ET.Element, str]]:
    """Extract (w_element, separator) pairs matching extract_verse_words exactly."""
    children = list(verse_el)
    stream: List[Tuple[str, object]] = []
    i = 0
    n = len(children)

    def _emit_rdg(rdg: ET.Element) -> None:
        for ch in list(rdg):
            if ch.tag == O_W:
                stream.append(("W", ch))
            elif ch.tag == O_SEG:
                stream.append(("SEG", ch.attrib.get("type", "")))

    while i < n:
        el = children[i]
        if el.tag == O_W and el.attrib.get("type") == "x-ketiv":
            ketiv_buf = [el]
            j = i + 1
            while j < n:
                nxt = children[j]
                if nxt.tag == O_W and nxt.attrib.get("type") == "x-ketiv":
                    ketiv_buf.append(nxt)
                    j += 1
                elif nxt.tag == O_SEG:
                    j += 1
                elif nxt.tag == O_NOTE and nxt.attrib.get("type") != "variant":
                    j += 1
                else:
                    break
            if (
                j < n
                and children[j].tag == O_NOTE
                and children[j].attrib.get("type") == "variant"
            ):
                qere_rdg = _find_qere_rdg(children[j])
                if qere_rdg is not None:
                    _emit_rdg(qere_rdg)
                    i = j + 1
                    continue
            for kw in ketiv_buf:
                stream.append(("W", kw))
            i = j
        elif el.tag == O_NOTE:
            if el.attrib.get("type") == "variant":
                qere_rdg = _find_qere_rdg(el)
                if qere_rdg is not None:
                    _emit_rdg(qere_rdg)
            i += 1
        elif el.tag == O_W:
            stream.append(("W", el))
            i += 1
        elif el.tag == O_SEG:
            stream.append(("SEG", el.attrib.get("type", "")))
            i += 1
        else:
            i += 1

    # Pair each W item with trailing SEG markers before the next W
    result: List[Tuple[ET.Element, str]] = []
    idx = 0
    slen = len(stream)
    while idx < slen:
        kind, payload = stream[idx]
        if kind != "W":
            idx += 1
            continue
        seg_types: List[str] = []
        k = idx + 1
        while k < slen and stream[k][0] == "SEG":
            seg_types.append(str(stream[k][1]))
            k += 1
        has_next_word = k < slen
        if "x-maqqef" in seg_types:
            sep = "־"
        elif "x-paseq" in seg_types:
            sep = " ׀ "
        elif "x-sof-pasuq" in seg_types:
            sep = "׃"
        elif not has_next_word:
            sep = ""
        else:
            sep = " "
        result.append((payload, sep))  # type: ignore[arg-type]
        idx = k

    return result


def build_database() -> None:
    t0 = time.perf_counter()
    ensure_datasets()
    resolver = LexiconResolver(
        CACHE_DIR / "LexicalIndex.xml",
        CACHE_DIR / "AugIndex.xml",
    )

    books_rows: List[Tuple[int, str, str, str, int, int]] = []
    # Raw verses hold unresolved entry keys first; replaced with integer entry_id after sorting
    raw_verses: List[
        Tuple[
            int,
            int,
            int,
            int,
            str,
            str,
            List[Tuple[Tuple[str, str, str], str, str, str]],
        ]
    ] = []
    entry_stats: Dict[Tuple[str, str, str], List[object]] = {}
    occ_by_verse_key: Dict[Tuple[int, Tuple[str, str, str]], Tuple[int, int]] = defaultdict(
        lambda: (0, 0)
    )

    verse_id = 0
    total_tokens = 0

    for book_id, (xml_name, book_he) in enumerate(TANAKH_BOOKS, start=1):
        osis_code = xml_name[:-4]
        division = get_book_division(book_id)
        tree_root = ET.parse(WLC_DIR / xml_name).getroot()
        book_verses = 0
        book_tokens = 0

        for verse_el in tree_root.findall(".//o:verse", NS_OSIS):
            osis_id = verse_el.attrib.get("osisID", "")
            parts = osis_id.split(".")
            if len(parts) != 3:
                raise ValueError(f"Unexpected osisID: {osis_id} in {xml_name}")
            chap = int(parts[1])
            verse_num = int(parts[2])
            verse_id += 1
            book_verses += 1
            ref_he = f"{book_he}, {to_gematria(chap)}, {to_gematria(verse_num)}"

            cons_words: List[str] = []
            verse_tokens: List[Tuple[Tuple[str, str, str], str, str, str]] = []
            verse_occ_counts: Dict[Tuple[str, str, str], int] = defaultdict(int)

            for w_el, sep in extract_verse_tokens_with_seps(verse_el):
                raw_text = "".join(w_el.itertext())
                word_voc = normalize_vocalized_word(raw_text)
                if not word_voc:
                    continue
                word_cant = normalize_cantillated_word(raw_text)
                lemma = w_el.attrib.get("lemma", "")
                morph = w_el.attrib.get("morph", "")
                root_str, binyan_str = resolver.resolve(lemma, morph)

                key = (word_voc, root_str, binyan_str)
                verse_tokens.append((key, word_voc, word_cant, sep))
                cons_words.append(strip_to_consonants(word_voc))
                verse_occ_counts[key] += 1
                total_tokens += 1
                book_tokens += 1

                st = entry_stats.get(key)
                if st is None:
                    entry_stats[key] = [1, 1, ref_he]
                else:
                    st[0] = int(st[0]) + 1

            for key, cnt in verse_occ_counts.items():
                occ_by_verse_key[(verse_id, key)] = (book_id, cnt)
                if int(entry_stats[key][0]) > cnt:
                    entry_stats[key][1] = int(entry_stats[key][1]) + 1

            text_cons = " ".join(cons_words)
            raw_verses.append(
                (verse_id, book_id, chap, verse_num, ref_he, text_cons, verse_tokens)
            )

        books_rows.append((book_id, osis_code, book_he, division, book_verses, book_tokens))

    # Recompute exact verses_count per key cleanly from occ_by_verse_key
    verses_count_map: Dict[Tuple[str, str, str], int] = defaultdict(int)
    for _, key in occ_by_verse_key.keys():
        verses_count_map[key] += 1

    sorted_keys = sorted(
        entry_stats.keys(),
        key=lambda k: (consonantal_sort_key(k[0]), k[0], k[1], k[2]),
    )
    key_to_id: Dict[Tuple[str, str, str], int] = {}
    entries_rows: List[
        Tuple[int, str, str, str, str, str, str, str, int, int, int, str]
    ] = []

    for eid, key in enumerate(sorted_keys, start=1):
        key_to_id[key] = eid
        word_voc, root_str, binyan_str = key
        cons = strip_to_consonants(word_voc)
        cons_norm = cons.translate(FINAL_TO_MEDIAL)
        root_plain = "" if root_str == "-" else root_str.replace(".", "")
        is_aramaic = 1 if "(ארמית)" in binyan_str else 0
        base_binyan = unicodedata.normalize(
            "NFC", binyan_str.replace(" (ארמית)", "")
        )
        if base_binyan not in BINYAN_BASE_TO_GROUP:
            raise ValueError(f"Unmapped base binyan: {base_binyan!r}")
        binyan_group = BINYAN_BASE_TO_GROUP[base_binyan]
        occ_cnt = int(entry_stats[key][0])
        v_cnt = verses_count_map[key]
        first_ref = str(entry_stats[key][2])
        entries_rows.append(
            (
                eid,
                word_voc,
                cons,
                cons_norm,
                root_str,
                root_plain,
                binyan_str,
                binyan_group,
                is_aramaic,
                occ_cnt,
                v_cnt,
                first_ref,
            )
        )

    verses_rows: List[Tuple[int, int, int, int, str, str, str]] = []
    for vid, bid, chap, vnum, ref_he, text_cons, v_tokens in raw_verses:
        encoded = [
            [key_to_id[key], w_voc, w_cant, sep]
            for key, w_voc, w_cant, sep in v_tokens
        ]
        verses_rows.append(
            (
                vid,
                bid,
                chap,
                vnum,
                ref_he,
                text_cons,
                json.dumps(encoded, ensure_ascii=False, separators=(",", ":")),
            )
        )

    occ_rows: List[Tuple[int, int, int, int]] = [
        (key_to_id[key], vid, bid, cnt)
        for (vid, key), (bid, cnt) in occ_by_verse_key.items()
    ]

    if TMP_DB_PATH.exists():
        TMP_DB_PATH.unlink()

    conn = sqlite3.connect(TMP_DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode = OFF;")
        conn.execute("PRAGMA synchronous = OFF;")
        conn.executescript(
            """
            CREATE TABLE books (
                book_id INTEGER PRIMARY KEY,
                osis_code TEXT NOT NULL,
                name_he TEXT NOT NULL,
                division TEXT NOT NULL,
                verse_count INTEGER NOT NULL,
                token_count INTEGER NOT NULL
            );

            CREATE TABLE entries (
                entry_id INTEGER PRIMARY KEY,
                word TEXT NOT NULL,
                consonants TEXT NOT NULL,
                consonants_norm TEXT NOT NULL,
                root TEXT NOT NULL,
                root_plain TEXT NOT NULL,
                binyan TEXT NOT NULL,
                binyan_group TEXT NOT NULL,
                is_aramaic INTEGER NOT NULL,
                occurrences_count INTEGER NOT NULL,
                verses_count INTEGER NOT NULL,
                first_ref TEXT NOT NULL
            );

            CREATE TABLE verses (
                verse_id INTEGER PRIMARY KEY,
                book_id INTEGER NOT NULL,
                chapter INTEGER NOT NULL,
                verse INTEGER NOT NULL,
                ref_he TEXT NOT NULL,
                text_consonantal TEXT NOT NULL,
                tokens_json TEXT NOT NULL
            );

            CREATE TABLE occurrences (
                entry_id INTEGER NOT NULL,
                verse_id INTEGER NOT NULL,
                book_id INTEGER NOT NULL,
                count_in_verse INTEGER NOT NULL,
                PRIMARY KEY (entry_id, verse_id)
            ) WITHOUT ROWID;
            """
        )

        conn.executemany(
            "INSERT INTO books VALUES (?, ?, ?, ?, ?, ?);",
            books_rows,
        )
        conn.executemany(
            "INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
            entries_rows,
        )
        conn.executemany(
            "INSERT INTO verses VALUES (?, ?, ?, ?, ?, ?, ?);",
            verses_rows,
        )
        conn.executemany(
            "INSERT INTO occurrences VALUES (?, ?, ?, ?);",
            occ_rows,
        )

        conn.executescript(
            """
            CREATE INDEX idx_entries_cons ON entries(consonants);
            CREATE INDEX idx_entries_cons_norm ON entries(consonants_norm);
            CREATE INDEX idx_entries_word ON entries(word);
            CREATE INDEX idx_entries_root ON entries(root);
            CREATE INDEX idx_entries_root_plain ON entries(root_plain);
            CREATE INDEX idx_entries_freq ON entries(occurrences_count DESC);
            CREATE INDEX idx_entries_binyan ON entries(binyan_group, occurrences_count DESC);
            CREATE INDEX idx_occ_verse ON occurrences(verse_id);
            CREATE INDEX idx_occ_entry_book ON occurrences(entry_id, book_id, verse_id);
            CREATE INDEX idx_verses_loc ON verses(book_id, chapter, verse);
            ANALYZE;
            """
        )
        conn.commit()
    finally:
        conn.close()

    if DB_PATH.exists():
        DB_PATH.unlink()
    os.replace(TMP_DB_PATH, DB_PATH)

    # Verification assertions
    vconn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        cnt_entries = vconn.execute("SELECT COUNT(*) FROM entries;").fetchone()[0]
        sum_occ = vconn.execute("SELECT SUM(occurrences_count) FROM entries;").fetchone()[0]
        cnt_verses = vconn.execute("SELECT COUNT(*) FROM verses;").fetchone()[0]
        cnt_books = vconn.execute("SELECT COUNT(*) FROM books;").fetchone()[0]
    finally:
        vconn.close()

    assert total_tokens == 305517, f"Unexpected token count: {total_tokens}"
    assert cnt_entries == 54153, f"Unexpected entry count: {cnt_entries}"
    assert sum_occ == 305517, f"Unexpected sum(occurrences_count): {sum_occ}"
    assert cnt_books == 39, f"Unexpected book count: {cnt_books}"

    elapsed = time.perf_counter() - t0
    size_mb = DB_PATH.stat().st_size / (1024 * 1024)
    print(
        f"Built {DB_PATH} ({size_mb:.2f} MB) in {elapsed:.1f}s | "
        f"books={cnt_books}, verses={cnt_verses}, entries={cnt_entries}, tokens={sum_occ}"
    )


if __name__ == "__main__":
    build_database()
