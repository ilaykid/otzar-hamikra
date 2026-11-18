"""Build a complete vocalized and morphologically-analyzed Tanakh concordance.

Downloads (and caches locally) OpenScriptures MorphHB (WLC) and HebrewLexicon
(LexicalIndex.xml, AugIndex.xml), aggregates all ~305,500 word tokens across the
39 OSIS files in canonical Jewish Tanakh order, and exports:
  1. tanakh_concordance.csv  (UTF-8 with BOM, untruncated)
  2. tanakh_concordance.xlsx (RTL Excel workbook with overflow sheet for >32k chars)
"""

from __future__ import annotations

import csv
import os
import re
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

import openpyxl

BASE_DIR = Path(r"C:\robi\tanakh-concordance")
CACHE_DIR = BASE_DIR / "data_cache"
WLC_DIR = CACHE_DIR / "wlc"
CSV_PATH = BASE_DIR / "tanakh_concordance.csv"
XLSX_PATH = BASE_DIR / "tanakh_concordance.xlsx"

DATASETS = {
    "morphhb-master.zip": "https://codeload.github.com/openscriptures/morphhb/zip/refs/heads/master",
    "LexicalIndex.xml": "https://raw.githubusercontent.com/openscriptures/HebrewLexicon/master/LexicalIndex.xml",
    "AugIndex.xml": "https://raw.githubusercontent.com/openscriptures/HebrewLexicon/master/AugIndex.xml",
}

NS_MORPH = {"m": "http://openscriptures.github.com/morphhb/namespace"}
NS_OSIS = {"o": "http://www.bibletechnologies.net/2003/OSIS/namespace"}
OSIS_NS = "{http://www.bibletechnologies.net/2003/OSIS/namespace}"
O_W = f"{OSIS_NS}w"
O_SEG = f"{OSIS_NS}seg"
O_NOTE = f"{OSIS_NS}note"

# Canonical Masoretic Jewish Tanakh order (Torah, Nevi'im, Ketuvim)
TANAKH_BOOKS: List[Tuple[str, str]] = [
    ("Gen.xml", "בראשית"),
    ("Exod.xml", "שמות"),
    ("Lev.xml", "ויקרא"),
    ("Num.xml", "במדבר"),
    ("Deut.xml", "דברים"),
    ("Josh.xml", "יהושע"),
    ("Judg.xml", "שופטים"),
    ("1Sam.xml", "שמואל א"),
    ("2Sam.xml", "שמואל ב"),
    ("1Kgs.xml", "מלכים א"),
    ("2Kgs.xml", "מלכים ב"),
    ("Isa.xml", "ישעיהו"),
    ("Jer.xml", "ירמיהו"),
    ("Ezek.xml", "יחזקאל"),
    ("Hos.xml", "הושע"),
    ("Joel.xml", "יואל"),
    ("Amos.xml", "עמוס"),
    ("Obad.xml", "עובדיה"),
    ("Jonah.xml", "יונה"),
    ("Mic.xml", "מיכה"),
    ("Nah.xml", "נחום"),
    ("Hab.xml", "חבקוק"),
    ("Zeph.xml", "צפניה"),
    ("Hag.xml", "חגי"),
    ("Zech.xml", "זכריה"),
    ("Mal.xml", "מלאכי"),
    ("Ps.xml", "תהילים"),
    ("Prov.xml", "משלי"),
    ("Job.xml", "איוב"),
    ("Song.xml", "שיר השירים"),
    ("Ruth.xml", "רות"),
    ("Lam.xml", "איכה"),
    ("Eccl.xml", "קהלת"),
    ("Esth.xml", "אסתר"),
    ("Dan.xml", "דניאל"),
    ("Ezra.xml", "עזרא"),
    ("Neh.xml", "נחמיה"),
    ("1Chr.xml", "דברי הימים א"),
    ("2Chr.xml", "דברי הימים ב"),
]

FINAL_TO_MEDIAL = str.maketrans("ךםןףץ", "כמנפצ")
PREFIX_LEMMAS = frozenset({"b", "c", "d", "k", "l", "m", "s", "i", ""})
NON_ROOT_POS = frozenset({"R", "P", "C", "T", "I"})

HEB_BINYAN_MAP: Dict[str, str] = {
    "q": "פָּעַל",
    "j": "פָּעַל",
    "N": "נִפְעַל",
    "p": "פִּעֵל",
    "o": "פִּעֵל",
    "m": "פִּעֵל",
    "k": "פִּעֵל",
    "l": "פִּעֵל",
    "i": "פִּעֵל",
    "P": "פֻּעַל",
    "O": "פֻּעַל",
    "M": "פֻּעַל",
    "K": "פֻּעַל",
    "L": "פֻּעַל",
    "Q": "פֻּעַל",
    "h": "הִפְעִיל",
    "c": "הִפְעִיל",
    "H": "הֻפְעַל",
    "t": "הִתְפַּעֵל",
    "r": "הִתְפַּעֵל",
    "f": "הִתְפַּעֵל",
    "D": "הִתְפַּעֵל",
    "u": "הִתְפַּעֵל",
    "v": "הִתְפַּעֵל",
    "w": "הִתְפַּעֵל",
    "y": "הִתְפַּעֵל",
    "z": "הִתְפַּעֵל",
}

ARC_BINYAN_MAP: Dict[str, str] = {
    "q": "פָּעַל (ארמית)",
    "Q": "פָּעַל (ארמית)",
    "p": "פִּעֵל (ארמית)",
    "o": "פִּעֵל (ארמית)",
    "m": "פִּעֵל (ארמית)",
    "l": "פִּעֵל (ארמית)",
    "a": "הִפְעִיל (ארמית)",
    "h": "הִפְעִיל (ארמית)",
    "s": "הִפְעִיל (ארמית)",
    "e": "הִפְעִיל (ארמית)",
    "c": "הִפְעִיל (ארמית)",
    "H": "הֻפְעַל (ארמית)",
    "b": "הֻפְעַל (ארמית)",
    "u": "הִתְפַּעֵל (ארמית)",
    "i": "הִתְפַּעֵל (ארמית)",
    "P": "הִתְפַּעֵל (ארמית)",
    "M": "הִתְפַּעֵל (ארמית)",
    "t": "הִתְפַּעֵל (ארמית)",
    "v": "הִתְפַּעֵל (ארמית)",
    "w": "הִתְפַּעֵל (ארמית)",
    "z": "הִתְפַּעֵל (ארמית)",
    "r": "הִתְפַּעֵל (ארמית)",
    "f": "הִתְפַּעֵל (ארמית)",
    "L": "הִתְפַּעֵל (ארמית)",
    "O": "הִתְפַּעֵל (ארמית)",
    "G": "הִתְפַּעֵל (ארמית)",
}

EXCEL_SAFE_MAX = 32000

_GEMATRIA_HUNDREDS = {100: "ק", 200: "ר", 300: "ש", 400: "ת"}
_GEMATRIA_TENS = {
    10: "י", 20: "כ", 30: "ל", 40: "מ", 50: "נ",
    60: "ס", 70: "ע", 80: "פ", 90: "צ",
}
_GEMATRIA_UNITS = {
    1: "א", 2: "ב", 3: "ג", 4: "ד", 5: "ה",
    6: "ו", 7: "ז", 8: "ח", 9: "ט",
}
_GEMATRIA_CACHE: Dict[int, str] = {}


def to_gematria(n: int) -> str:
    """Convert a positive integer (1..499) to punctuated Hebrew Gematria."""
    cached = _GEMATRIA_CACHE.get(n)
    if cached is not None:
        return cached
    if n <= 0 or n >= 500:
        raise ValueError(f"Unsupported Gematria number: {n}")
    letters: List[str] = []
    rem = n
    if rem >= 100:
        h = (rem // 100) * 100
        letters.append(_GEMATRIA_HUNDREDS[h])
        rem %= 100
    if rem == 15:
        letters.extend(["ט", "ו"])
    elif rem == 16:
        letters.extend(["ט", "ז"])
    else:
        if rem >= 10:
            t = (rem // 10) * 10
            letters.append(_GEMATRIA_TENS[t])
            rem %= 10
        if rem > 0:
            letters.append(_GEMATRIA_UNITS[rem])
    if len(letters) == 1:
        res = f"{letters[0]}'"
    else:
        res = f"{''.join(letters[:-1])}\"{letters[-1]}"
    _GEMATRIA_CACHE[n] = res
    return res


def ensure_datasets() -> None:
    """Download and extract required XML datasets into CACHE_DIR if missing."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    for filename, url in DATASETS.items():
        target = CACHE_DIR / filename
        if not target.exists():
            print(f"Downloading {filename}...")
            urllib.request.urlretrieve(url, target)
    if not WLC_DIR.exists() or len(list(WLC_DIR.glob("*.xml"))) < 39:
        WLC_DIR.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(CACHE_DIR / "morphhb-master.zip") as zf:
            for member in zf.namelist():
                if member.startswith("morphhb-master/wlc/") and member.endswith(".xml"):
                    out_path = WLC_DIR / Path(member).name
                    out_path.write_bytes(zf.read(member))


def normalize_vocalized_word(raw_text: str) -> str:
    """Keep Hebrew letters, standard Niqqud, Dagesh, and Shin/Sin dots in NFC."""
    chars: List[str] = []
    for ch in raw_text:
        if ch in ("/", "+") or ch.isspace():
            continue
        if ch == "\u05C7":  # Qamats Qatan -> Qamats
            ch = "\u05B8"
        elif ch == "\u05BA":  # Holam Haser for Vav -> Holam
            ch = "\u05B9"
        code = ord(ch)
        if (
            0x05D0 <= code <= 0x05EA
            or 0x05B0 <= code <= 0x05BB
            or code in (0x05BC, 0x05C1, 0x05C2)
        ):
            chars.append(ch)
    return unicodedata.normalize("NFC", "".join(chars))


def consonantal_sort_key(vocalized_word: str) -> str:
    """Return normalized consonant-only key (final letters mapped to medial)."""
    cons = [ch for ch in vocalized_word if "\u05D0" <= ch <= "\u05EA"]
    return "".join(cons).translate(FINAL_TO_MEDIAL)


class LexiconResolver:
    """Resolves MorphHB Strong's lemmas and OSHM morphology to Hebrew root & binyan."""

    def __init__(self, lexical_index_path: Path, aug_index_path: Path) -> None:
        aug_root = ET.parse(aug_index_path).getroot()
        self.aug_map: Dict[str, str] = {
            el.attrib["aug"]: (el.text or "").strip()
            for el in aug_root.findall("m:w", NS_MORPH)
        }

        lex_root = ET.parse(lexical_index_path).getroot()
        self.entries: Dict[str, Tuple[str, str, str, str, str, str]] = {}
        self.xref_heb: Dict[str, str] = {}
        self.xref_arc: Dict[str, str] = {}

        for part in lex_root.findall("m:part", NS_MORPH):
            lang = part.attrib.get("{http://www.w3.org/XML/1998/namespace}lang", "heb")
            for entry in part.findall("m:entry", NS_MORPH):
                eid = entry.attrib["id"]
                w_text = entry.findtext("m:w", "", NS_MORPH)
                pos = entry.findtext("m:pos", "", NS_MORPH)
                etym = entry.find("m:etym", NS_MORPH)
                etype = etym.attrib.get("type", "") if etym is not None else ""
                eroot = etym.attrib.get("root", "") if etym is not None else ""
                etext = (etym.text or "").strip() if etym is not None else ""
                self.entries[eid] = (lang, w_text, pos, etype, eroot, etext)

                xref = entry.find("m:xref", NS_MORPH)
                if xref is not None and "strong" in xref.attrib:
                    strong_val = xref.attrib["strong"]
                    target_map = self.xref_arc if lang == "arc" else self.xref_heb
                    target_map.setdefault(strong_val, eid)

        self._root_cache: Dict[Tuple[str, str], str] = {}

    def _lookup_entry_id(self, strong_token: str, lang_code: str) -> str | None:
        key = strong_token.replace(" ", "")
        base = re.sub(r"[a-z]+$", "", key)
        xref_map = self.xref_arc if lang_code == "A" else self.xref_heb
        for candidate in (key, base):
            if candidate in self.aug_map:
                eid = self.aug_map[candidate]
                entry = self.entries.get(eid)
                if entry is not None:
                    expected_lang = "arc" if lang_code == "A" else "heb"
                    if entry[0] == expected_lang:
                        return eid
            if candidate in xref_map:
                return xref_map[candidate]
        # Fallback to aug_map even if cross-language (e.g., loanword)
        for candidate in (key, base):
            if candidate in self.aug_map:
                return self.aug_map[candidate]
        return None

    def _trace_root_letters(self, eid: str) -> str:
        cur = eid
        seen = set()
        for _ in range(8):
            if not cur or cur in seen or cur not in self.entries:
                return ""
            seen.add(cur)
            _, w_text, pos, etype, eroot, etext = self.entries[cur]
            if eroot:
                return eroot
            if etype == "sub" and etext:
                cur = etext.split(",")[0].strip()
                continue
            if pos == "V" and w_text:
                return w_text
            return ""
        return ""

    @staticmethod
    def _format_root(raw_root: str) -> str:
        letters = [
            ch for ch in unicodedata.normalize("NFC", raw_root)
            if "\u05D0" <= ch <= "\u05EA"
        ]
        if len(letters) < 2:
            return "-"
        medial = "".join(letters).translate(FINAL_TO_MEDIAL)
        return ".".join(medial)

    def resolve(self, lemma: str, morph: str) -> Tuple[str, str]:
        """Return (root_str, binyan_str) for a MorphHB <w> element."""
        lang_code = morph[0] if morph else "H"
        segs = morph[1:].split("/") if len(morph) > 1 else []
        non_suffix = [s for s in segs if s and not s.startswith("S")]

        # Resolve binyan from verb segment if present
        binyan = "- (ארמית)" if lang_code == "A" else "-"
        for seg in non_suffix:
            if seg.startswith("V") and len(seg) >= 2:
                stem_code = seg[1]
                if lang_code == "A":
                    if stem_code not in ARC_BINYAN_MAP:
                        raise ValueError(f"Unmapped Aramaic verb stem: {stem_code} in {morph}")
                    binyan = ARC_BINYAN_MAP[stem_code]
                else:
                    if stem_code not in HEB_BINYAN_MAP:
                        raise ValueError(f"Unmapped Hebrew verb stem: {stem_code} in {morph}")
                    binyan = HEB_BINYAN_MAP[stem_code]
                break

        # Determine stem POS (ignore trailing Aramaic definite article 'Td' or stray suffix tags)
        lexical_segs = [s for s in non_suffix if s[0] in ("V", "N", "A", "D")]
        if lexical_segs:
            stem_seg = lexical_segs[-1]
        else:
            stem_seg = non_suffix[-1] if non_suffix else ""
        stem_pos = stem_seg[0] if stem_seg else ""
        if stem_pos in NON_ROOT_POS:
            return "-", binyan

        # Extract Strong's stem token from lemma
        lemma_parts = [p.strip().rstrip("+") for p in lemma.split("/")]
        stem_tokens = [p for p in lemma_parts if p not in PREFIX_LEMMAS]
        if not stem_tokens:
            return "-", binyan

        strong_token = stem_tokens[-1]
        cache_key = (strong_token, lang_code)
        root_str = self._root_cache.get(cache_key)
        if root_str is None:
            eid = self._lookup_entry_id(strong_token, lang_code)
            raw_root = self._trace_root_letters(eid) if eid else ""
            root_str = self._format_root(raw_root) if raw_root else "-"
            self._root_cache[cache_key] = root_str

        return root_str, binyan


def _find_qere_rdg(note_el: ET.Element) -> ET.Element | None:
    for rdg in note_el.findall("o:rdg", NS_OSIS):
        if rdg.attrib.get("type") == "x-qere":
            return rdg
    return None


def extract_verse_words(verse_el: ET.Element) -> List[ET.Element]:
    """Extract vocalized <w> elements from a verse, replacing Ketiv with Qere."""
    children = list(verse_el)
    emitted: List[ET.Element] = []
    i = 0
    n = len(children)

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
                    emitted.extend(qere_rdg.findall("o:w", NS_OSIS))
                    i = j + 1
                    continue
            # Ketiv-welo-Qere fallback
            emitted.extend(ketiv_buf)
            i = j
        elif el.tag == O_NOTE:
            if el.attrib.get("type") == "variant":
                qere_rdg = _find_qere_rdg(el)
                if qere_rdg is not None:
                    emitted.extend(qere_rdg.findall("o:w", NS_OSIS))
            i += 1
        elif el.tag == O_W:
            emitted.append(el)
            i += 1
        else:
            i += 1

    return emitted


def split_sources_for_excel(sources_str: str, limit: int = EXCEL_SAFE_MAX) -> List[str]:
    """Split a semicolon-separated sources string into chunks <= limit chars."""
    chunks: List[str] = []
    pos = 0
    total = len(sources_str)
    while pos < total:
        if total - pos <= limit:
            chunks.append(sources_str[pos:])
            break
        cut = sources_str.rfind("; ", pos, pos + limit)
        if cut <= pos:
            cut = pos + limit
            chunks.append(sources_str[pos:cut])
            pos = cut
        else:
            chunks.append(sources_str[pos:cut])
            pos = cut + 2
    return chunks


def build_concordance() -> None:
    ensure_datasets()
    resolver = LexiconResolver(
        CACHE_DIR / "LexicalIndex.xml",
        CACHE_DIR / "AugIndex.xml",
    )

    # Map (word, root, binyan) -> OrderedDict[verse_ref, count_in_verse]
    entries: Dict[Tuple[str, str, str], Dict[str, int]] = defaultdict(dict)
    total_tokens = 0

    for xml_name, book_he in TANAKH_BOOKS:
        xml_path = WLC_DIR / xml_name
        tree_root = ET.parse(xml_path).getroot()
        for verse_el in tree_root.findall(".//o:verse", NS_OSIS):
            osis_id = verse_el.attrib.get("osisID", "")
            parts = osis_id.split(".")
            if len(parts) != 3:
                raise ValueError(f"Unexpected osisID: {osis_id} in {xml_name}")
            chap = int(parts[1])
            verse_num = int(parts[2])
            verse_ref = f"{book_he}, {to_gematria(chap)}, {to_gematria(verse_num)}"

            for w_el in extract_verse_words(verse_el):
                raw_text = "".join(w_el.itertext())
                word = normalize_vocalized_word(raw_text)
                if not word:
                    continue
                lemma = w_el.attrib.get("lemma", "")
                morph = w_el.attrib.get("morph", "")
                root_str, binyan_str = resolver.resolve(lemma, morph)

                key = (word, root_str, binyan_str)
                verse_dict = entries[key]
                verse_dict[verse_ref] = verse_dict.get(verse_ref, 0) + 1
                total_tokens += 1

    print(f"Processed {len(TANAKH_BOOKS)} books, {total_tokens} total tokens, {len(entries)} unique rows.")

    sorted_keys = sorted(
        entries.keys(),
        key=lambda k: (consonantal_sort_key(k[0]), k[0], k[1], k[2]),
    )

    headers = ["המילה", "מספר מופעים", "מקורות", "שורש", "בניין"]

    # Export CSV (untruncated) + Excel (with overflow sheet) in one pass over sorted_keys
    wb = openpyxl.Workbook(write_only=True)
    ws_main = wb.create_sheet(title="קונקורדנציה")
    ws_main.views.sheetView[0].rightToLeft = True
    ws_main.column_dimensions["A"].width = 22
    ws_main.column_dimensions["B"].width = 16
    ws_main.column_dimensions["C"].width = 70
    ws_main.column_dimensions["D"].width = 16
    ws_main.column_dimensions["E"].width = 20
    ws_main.append(headers)

    ws_overflow = wb.create_sheet(title="מקורות מלאים")
    ws_overflow.views.sheetView[0].rightToLeft = True
    ws_overflow.column_dimensions["A"].width = 22
    ws_overflow.column_dimensions["B"].width = 16
    ws_overflow.column_dimensions["C"].width = 20
    ws_overflow.column_dimensions["D"].width = 10
    ws_overflow.column_dimensions["E"].width = 90
    ws_overflow.append(["המילה", "שורש", "בניין", "חלק", "מקורות"])

    overflow_word_count = 0
    sample_words = [
        unicodedata.normalize("NFC", w)
        for w in (
            "בְּרֵאשִׁית", "בָּרָא", "אֱלֹהִים", "אֵת", "הַשָּׁמַיִם", "וְאֵת", "הָאָרֶץ",
            "כֹּל", "כָּל", "בְּכָל", "יֵלֵךְ", "וַיֵּלֶךְ", "הִתְהַלֵּךְ", "בָּנוּ",
            "מַלְכָּא", "שְׁמַיָּא",
        )
    ]
    sample_word_set = set(sample_words)
    rows_by_word: Dict[str, List[Tuple[str, int, str, str, str]]] = defaultdict(list)

    with open(CSV_PATH, "w", newline="", encoding="utf-8-sig") as f_csv:
        writer = csv.writer(f_csv)
        writer.writerow(headers)

        for key in sorted_keys:
            word, root_str, binyan_str = key
            verse_counts = entries[key]
            count = sum(verse_counts.values())
            sources_str = "; ".join(
                f"{ref} (×{cnt})" if cnt > 1 else ref
                for ref, cnt in verse_counts.items()
            )
            writer.writerow([word, count, sources_str, root_str, binyan_str])

            if len(sources_str) > EXCEL_SAFE_MAX:
                overflow_word_count += 1
                cut = sources_str.rfind("; ", 0, EXCEL_SAFE_MAX - 100)
                if cut <= 0:
                    cut = EXCEL_SAFE_MAX - 100
                preview = (
                    sources_str[:cut]
                    + f" ... [המשך בגיליון 'מקורות מלאים' — סה\"כ {count} מופעים]"
                )
                ws_main.append([word, count, preview, root_str, binyan_str])
                chunks = split_sources_for_excel(sources_str)
                for idx, chunk in enumerate(chunks, start=1):
                    ws_overflow.append([word, root_str, binyan_str, idx, chunk])
            else:
                ws_main.append([word, count, sources_str, root_str, binyan_str])

            if word in sample_word_set:
                rows_by_word[word].append((word, count, sources_str[:120], root_str, binyan_str))

    wb.save(XLSX_PATH)
    print(f"Saved CSV: {CSV_PATH}")
    print(f"Saved XLSX: {XLSX_PATH} (overflow rows in main sheet: {overflow_word_count})")

    verify_outputs(total_tokens, len(entries), rows_by_word, sample_words)


def verify_outputs(
    total_tokens: int,
    expected_rows: int,
    rows_by_word: Dict[str, List[Tuple[str, int, str, str, str]]],
    sample_words: List[str],
) -> None:
    """Run integrity and linguistic spot checks on the generated files."""
    assert 300000 <= total_tokens <= 310000, f"Unexpected token total: {total_tokens}"
    assert to_gematria(15) == 'ט"ו' and to_gematria(16) == 'ט"ז'
    assert to_gematria(115) == 'קט"ו' and to_gematria(116) == 'קט"ז'

    print("\n=== Spot Checks (Genesis 1:1 & User Examples) ===")
    for norm_sw in sample_words:
        found = rows_by_word.get(norm_sw, [])
        print(f"  {norm_sw}:")
        for r in found:
            print(f"    count={r[1]} | root={r[3]} | binyan={r[4]} | src={r[2]}")

    # Verify CSV and XLSX row counts match and zero invalid Gematria strings exist
    with open(CSV_PATH, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        csv_header = next(reader)
        csv_rows = 0
        bad_gematria = 0
        for row in reader:
            csv_rows += 1
            if 'י"ה' in row[2] or 'י"ו' in row[2]:
                bad_gematria += 1
    assert csv_rows == expected_rows, f"CSV row mismatch: {csv_rows} != {expected_rows}"
    assert bad_gematria == 0, f"Found invalid Gematria in {bad_gematria} rows"

    wb_check = openpyxl.load_workbook(XLSX_PATH, read_only=True)
    ws_check = wb_check["קונקורדנציה"]
    xlsx_rows = sum(1 for _ in ws_check.iter_rows(min_row=2, values_only=True))
    wb_check.close()
    assert xlsx_rows == csv_rows, f"XLSX row mismatch: {xlsx_rows} != {csv_rows}"
    print(f"\nVerification PASSED: CSV rows={csv_rows}, XLSX rows={xlsx_rows}, total_tokens={total_tokens}, bad_gematria={bad_gematria}")


if __name__ == "__main__":
    build_concordance()
