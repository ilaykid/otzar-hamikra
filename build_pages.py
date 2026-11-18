"""Build compact static JSON bundles and GitHub Pages assets in C:\\robi\\tanakh-concordance\\docs."""

from __future__ import annotations

import gzip
import json
import shutil
import sqlite3
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from build_concordance import BASE_DIR, XLSX_PATH
from build_db import DB_PATH

DOCS_DIR = BASE_DIR / "docs"
DATA_DIR = DOCS_DIR / "data"

SEP_TO_CODE: Dict[str, int] = {
    " ": 0,
    "־": 1,
    " ׀ ": 2,
    "׃": 3,
    "": 4,
}


def build_pages_bundle() -> None:
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DOCS_DIR / ".nojekyll").write_text("", encoding="utf-8")

    if XLSX_PATH.exists():
        shutil.copy2(XLSX_PATH, DOCS_DIR / "tanakh_concordance.xlsx")

    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        totals_row = conn.execute(
            """
            SELECT
                (SELECT SUM(occurrences_count) FROM entries) AS tokens,
                (SELECT COUNT(*) FROM entries) AS entries,
                (SELECT COUNT(*) FROM verses) AS verses,
                (SELECT COUNT(DISTINCT root) FROM entries WHERE root != '-') AS roots
            """
        ).fetchone()
        totals = {k: int(totals_row[k]) for k in totals_row.keys()}

        book_ranges = {
            r["book_id"]: (r["min_vid"], r["max_vid"])
            for r in conn.execute(
                "SELECT book_id, MIN(verse_id) AS min_vid, MAX(verse_id) AS max_vid "
                "FROM verses GROUP BY book_id;"
            ).fetchall()
        }
        books = []
        for r in conn.execute("SELECT * FROM books ORDER BY book_id;").fetchall():
            min_vid, max_vid = book_ranges[r["book_id"]]
            books.append(
                {
                    "book_id": r["book_id"],
                    "osis_code": r["osis_code"],
                    "name_he": r["name_he"],
                    "division": r["division"],
                    "verse_count": r["verse_count"],
                    "token_count": r["token_count"],
                    "min_vid": min_vid,
                    "max_vid": max_vid,
                }
            )

        def _find_eid(word: str, root: str) -> Optional[int]:
            w_nfc = unicodedata.normalize("NFC", word)
            row = conn.execute(
                "SELECT entry_id FROM entries WHERE word = ? AND root = ? "
                "ORDER BY occurrences_count DESC LIMIT 1;",
                (w_nfc, root),
            ).fetchone()
            return int(row["entry_id"]) if row else None

        spotlights = {
            "banu_entry_id": _find_eid("בָּנוּ", "ב.נ.ה"),
            "kol_qamats_id": _find_eid("כָּל", "כ.ל.ל"),
            "kol_holam_id": _find_eid("כֹּל", "כ.ל.ל"),
            "bara_entry_id": _find_eid("בָּרָא", "ב.ר.א"),
            "default_root": "ה.ל.כ",
        }

        roots_list = ["-"]
        root_to_idx: Dict[str, int] = {"-": 0}
        binyanim_list: List[List[Any]] = []
        binyan_to_idx: Dict[Tuple[str, str, int], int] = {}
        entries_arr: List[Any] = [None]

        for r in conn.execute(
            "SELECT entry_id, word, root, binyan, binyan_group, is_aramaic, "
            "occurrences_count, verses_count FROM entries ORDER BY entry_id ASC;"
        ).fetchall():
            assert r["entry_id"] == len(entries_arr), "Non-contiguous entry_id"
            root_str = r["root"]
            if root_str not in root_to_idx:
                root_to_idx[root_str] = len(roots_list)
                roots_list.append(root_str)
            bkey = (r["binyan"], r["binyan_group"], int(r["is_aramaic"]))
            if bkey not in binyan_to_idx:
                binyan_to_idx[bkey] = len(binyanim_list)
                binyanim_list.append([r["binyan"], r["binyan_group"], int(r["is_aramaic"])])

            entries_arr.append(
                [
                    r["word"],
                    root_to_idx[root_str],
                    binyan_to_idx[bkey],
                    int(r["occurrences_count"]),
                    int(r["verses_count"]),
                ]
            )

        meta_obj = {
            "totals": totals,
            "books": books,
            "spotlights": spotlights,
            "roots": roots_list,
            "binyanim": binyanim_list,
            "entries": entries_arr,
        }
        meta_bytes = json.dumps(meta_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        (DATA_DIR / "meta.json").write_bytes(meta_bytes)
        print(
            f"meta.json: {len(meta_bytes)/1e6:.2f} MB raw | "
            f"{len(gzip.compress(meta_bytes))/1e6:.2f} MB gzip"
        )

        # Partition verses into 3 divisions: Torah (1..5), Nevi'im (6..26), Ketuvim (27..39)
        div_chunks: Dict[int, List[Any]] = {1: [], 2: [], 3: []}
        total_verses = 0
        total_tokens = 0

        for r in conn.execute(
            "SELECT verse_id, book_id, chapter, verse, tokens_json "
            "FROM verses ORDER BY verse_id ASC;"
        ).fetchall():
            bid = int(r["book_id"])
            div_idx = 1 if bid <= 5 else (2 if bid <= 26 else 3)
            raw_tokens = json.loads(r["tokens_json"])
            compact_tokens: List[List[Any]] = []
            for eid, w_voc, w_cant, sep in raw_tokens:
                cant_diff = "" if w_cant == w_voc else w_cant
                sep_code = SEP_TO_CODE[sep]
                if sep_code == 0:
                    compact_tokens.append([eid, cant_diff])
                else:
                    compact_tokens.append([eid, cant_diff, sep_code])
                total_tokens += 1
            div_chunks[div_idx].append(
                [int(r["verse_id"]), bid, int(r["chapter"]), int(r["verse"]), compact_tokens]
            )
            total_verses += 1

        assert total_verses == 23213, f"Expected 23213 verses, got {total_verses}"
        assert total_tokens == 305517, f"Expected 305517 tokens, got {total_tokens}"

        for idx, rows in div_chunks.items():
            v_bytes = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            out_file = DATA_DIR / f"verses_{idx}.json"
            out_file.write_bytes(v_bytes)
            print(
                f"{out_file.name}: {len(rows)} verses | {len(v_bytes)/1e6:.2f} MB raw | "
                f"{len(gzip.compress(v_bytes))/1e6:.2f} MB gzip"
            )
    finally:
        conn.close()


if __name__ == "__main__":
    build_pages_bundle()
