"""Flask web server and SQLite API for 'אוצר המקרא' Tanakh Concordance Explorer."""

from __future__ import annotations

import json
import sqlite3
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, abort, g, jsonify, request, send_from_directory

from build_concordance import (
    BASE_DIR,
    FINAL_TO_MEDIAL,
    normalize_vocalized_word,
    to_gematria,
)
from build_db import DB_PATH, strip_to_consonants

STATIC_DIR = BASE_DIR / "static"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.json.ensure_ascii = False  # type: ignore[attr-defined]


def get_db() -> sqlite3.Connection:
    db = getattr(g, "_db", None)
    if db is None:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
        db.row_factory = sqlite3.Row
        g._db = db
    return db


@app.teardown_appcontext
def close_db(_exc: Optional[BaseException]) -> None:
    db = getattr(g, "_db", None)
    if db is not None:
        db.close()


def _has_niqqud(text: str) -> bool:
    return any(0x05B0 <= ord(ch) <= 0x05C7 for ch in text)


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def build_entry_meta(
    db: sqlite3.Connection, parsed_verses: List[Dict[str, Any]]
) -> Dict[str, List[Any]]:
    """Collect unique entry_ids across returned verses and fetch compact metadata."""
    eids = set()
    for v in parsed_verses:
        for tok in v["tokens"]:
            eids.add(tok[0])
    if not eids:
        return {}
    placeholders = ",".join("?" for _ in eids)
    rows = db.execute(
        f"SELECT entry_id, word, root, binyan, occurrences_count FROM entries "
        f"WHERE entry_id IN ({placeholders});",
        tuple(eids),
    ).fetchall()
    return {
        str(r["entry_id"]): [r["word"], r["root"], r["binyan"], r["occurrences_count"]]
        for r in rows
    }


def _apply_binyan_filter(
    where_clauses: List[str], params: List[Any], binyan: str, alias: str = "e"
) -> None:
    if not binyan or binyan == "all":
        return
    if binyan == "aramaic":
        where_clauses.append(f"{alias}.is_aramaic = 1")
    elif binyan in ("paal", "nifal", "piel", "pual", "hifil", "hufal", "hitpael", "none"):
        where_clauses.append(f"{alias}.binyan_group = ?")
        params.append(binyan)


@app.route("/")
def index() -> Any:
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/overview")
def api_overview() -> Any:
    db = get_db()
    totals_row = db.execute(
        """
        SELECT
            (SELECT SUM(occurrences_count) FROM entries) AS tokens,
            (SELECT COUNT(*) FROM entries) AS entries,
            (SELECT COUNT(*) FROM verses) AS verses,
            (SELECT COUNT(DISTINCT root) FROM entries WHERE root != '-') AS roots
        """
    ).fetchone()

    books = [
        _row_to_dict(r)
        for r in db.execute(
            "SELECT book_id, osis_code, name_he, division, verse_count, token_count "
            "FROM books ORDER BY book_id;"
        ).fetchall()
    ]

    binyan_rows = db.execute(
        """
        SELECT binyan_group, COUNT(*) AS forms, SUM(occurrences_count) AS tokens
        FROM entries
        GROUP BY binyan_group;
        """
    ).fetchall()
    aramaic_row = db.execute(
        "SELECT COUNT(*) AS forms, SUM(occurrences_count) AS tokens FROM entries WHERE is_aramaic = 1;"
    ).fetchone()

    binyan_counts = {
        r["binyan_group"]: {"forms": r["forms"], "tokens": r["tokens"]}
        for r in binyan_rows
    }
    binyan_counts["aramaic"] = {
        "forms": aramaic_row["forms"] or 0,
        "tokens": aramaic_row["tokens"] or 0,
    }

    def _find_eid(word: str, root: Optional[str] = None) -> Optional[int]:
        w_nfc = unicodedata.normalize("NFC", word)
        if root is not None:
            row = db.execute(
                "SELECT entry_id FROM entries WHERE word = ? AND root = ? "
                "ORDER BY occurrences_count DESC LIMIT 1;",
                (w_nfc, root),
            ).fetchone()
        else:
            row = db.execute(
                "SELECT entry_id FROM entries WHERE word = ? "
                "ORDER BY occurrences_count DESC LIMIT 1;",
                (w_nfc,),
            ).fetchone()
        return int(row["entry_id"]) if row else None

    spotlights = {
        "banu_entry_id": _find_eid("בָּנוּ", "ב.נ.ה"),
        "kol_qamats_id": _find_eid("כָּל", "כ.ל.ל"),
        "kol_holam_id": _find_eid("כֹּל", "כ.ל.ל"),
        "bara_entry_id": _find_eid("בָּרָא", "ב.ר.א"),
        "default_root": "ה.ל.כ",
    }

    return jsonify(
        {
            "totals": _row_to_dict(totals_row),
            "books": books,
            "binyan_counts": binyan_counts,
            "spotlights": spotlights,
        }
    )


@app.route("/api/search")
def api_search() -> Any:
    db = get_db()
    q_raw = (request.args.get("q") or "").strip()
    binyan = (request.args.get("binyan") or "all").strip()
    division = (request.args.get("division") or "all").strip()
    book_id_raw = (request.args.get("book_id") or "").strip()
    sort = (request.args.get("sort") or "freq").strip()
    limit = min(max(int(request.args.get("limit") or 80), 1), 200)
    offset = max(int(request.args.get("offset") or 0), 0)

    book_id = int(book_id_raw) if book_id_raw.isdigit() else None

    where: List[str] = []
    params: List[Any] = []
    order_prefix = ""
    order_prefix_params: List[Any] = []
    matched_roots: List[Dict[str, Any]] = []

    _apply_binyan_filter(where, params, binyan, "e")

    if book_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM occurrences o WHERE o.entry_id = e.entry_id AND o.book_id = ?)"
        )
        params.append(book_id)
    elif division and division != "all":
        where.append(
            "EXISTS (SELECT 1 FROM occurrences o JOIN books b ON b.book_id = o.book_id "
            "WHERE o.entry_id = e.entry_id AND b.division = ?)"
        )
        params.append(division)

    if q_raw:
        if _has_niqqud(q_raw):
            q_voc = normalize_vocalized_word(q_raw)
            q_cons = strip_to_consonants(q_voc)
            where.append("(e.word = ? OR e.word LIKE ?)")
            params.extend([q_voc, f"{q_voc}%"])
            order_prefix = "CASE WHEN e.word = ? THEN 0 ELSE 1 END, "
            order_prefix_params.append(q_voc)
            if q_cons:
                q_med = q_cons.translate(FINAL_TO_MEDIAL)
                matched_roots = [
                    _row_to_dict(r)
                    for r in db.execute(
                        "SELECT root, COUNT(*) AS forms, SUM(occurrences_count) AS total_occ "
                        "FROM entries WHERE root != '-' AND (root_plain = ? OR root_plain LIKE ?) "
                        "GROUP BY root ORDER BY (root_plain = ?) DESC, total_occ DESC LIMIT 5;",
                        (q_med, f"{q_med}%", q_med),
                    ).fetchall()
                ]
        else:
            q_cons = strip_to_consonants(q_raw)
            if q_cons:
                q_med = q_cons.translate(FINAL_TO_MEDIAL)
                where.append(
                    "(e.consonants = ? OR e.root_plain = ? OR e.consonants LIKE ? OR e.consonants_norm LIKE ?)"
                )
                params.extend([q_cons, q_med, f"{q_cons}%", f"{q_med}%"])
                order_prefix = (
                    "CASE "
                    "WHEN e.consonants = ? THEN 0 "
                    "WHEN e.root_plain = ? THEN 1 "
                    "WHEN e.consonants LIKE ? THEN 2 "
                    "ELSE 3 END, "
                )
                order_prefix_params.extend([q_cons, q_med, f"{q_cons}%"])
                matched_roots = [
                    _row_to_dict(r)
                    for r in db.execute(
                        "SELECT root, COUNT(*) AS forms, SUM(occurrences_count) AS total_occ "
                        "FROM entries WHERE root != '-' AND (root_plain = ? OR root_plain LIKE ?) "
                        "GROUP BY root ORDER BY (root_plain = ?) DESC, total_occ DESC LIMIT 5;",
                        (q_med, f"{q_med}%", q_med),
                    ).fetchall()
                ]

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    if sort == "alpha":
        order_tail = "e.entry_id ASC"
    elif sort == "rare":
        order_tail = "e.occurrences_count ASC, e.entry_id ASC"
    else:
        order_tail = "e.occurrences_count DESC, e.entry_id ASC"

    total = db.execute(
        f"SELECT COUNT(*) FROM entries e {where_sql};", tuple(params)
    ).fetchone()[0]

    query_params = list(params) + order_prefix_params + [limit, offset]
    rows = db.execute(
        f"""
        SELECT e.entry_id, e.word, e.consonants, e.root, e.binyan, e.binyan_group,
               e.is_aramaic, e.occurrences_count, e.verses_count, e.first_ref
        FROM entries e
        {where_sql}
        ORDER BY {order_prefix}{order_tail}
        LIMIT ? OFFSET ?;
        """,
        tuple(query_params),
    ).fetchall()

    return jsonify(
        {
            "total": total,
            "items": [_row_to_dict(r) for r in rows],
            "matched_roots": matched_roots,
        }
    )


@app.route("/api/verses/search")
def api_verses_search() -> Any:
    db = get_db()
    q_raw = (request.args.get("q") or "").strip()
    division = (request.args.get("division") or "all").strip()
    book_id_raw = (request.args.get("book_id") or "").strip()
    limit = min(max(int(request.args.get("limit") or 30), 1), 100)
    offset = max(int(request.args.get("offset") or 0), 0)

    raw_words = [w for w in q_raw.replace("־", " ").split() if w]
    cons_words = [strip_to_consonants(w) for w in raw_words]
    cons_words = [w for w in cons_words if w]
    if not cons_words:
        return jsonify({"total": 0, "verses": [], "entry_meta": {}, "highlight_consonants": []})

    phrase = " ".join(cons_words)
    where = ["v.text_consonantal LIKE ?"]
    params: List[Any] = [f"%{phrase}%"]

    if book_id_raw.isdigit():
        where.append("v.book_id = ?")
        params.append(int(book_id_raw))
    elif division and division != "all":
        where.append("b.division = ?")
        params.append(division)

    where_sql = "WHERE " + " AND ".join(where)
    total = db.execute(
        f"SELECT COUNT(*) FROM verses v JOIN books b ON b.book_id = v.book_id {where_sql};",
        tuple(params),
    ).fetchone()[0]

    rows = db.execute(
        f"""
        SELECT v.verse_id, v.book_id, v.chapter, v.verse, v.ref_he, v.tokens_json
        FROM verses v
        JOIN books b ON b.book_id = v.book_id
        {where_sql}
        ORDER BY v.verse_id ASC
        LIMIT ? OFFSET ?;
        """,
        tuple(params + [limit, offset]),
    ).fetchall()

    verses_out: List[Dict[str, Any]] = []
    for r in rows:
        verses_out.append(
            {
                "verse_id": r["verse_id"],
                "book_id": r["book_id"],
                "chapter": r["chapter"],
                "verse": r["verse"],
                "ref_he": r["ref_he"],
                "tokens": json.loads(r["tokens_json"]),
            }
        )

    return jsonify(
        {
            "total": total,
            "verses": verses_out,
            "entry_meta": build_entry_meta(db, verses_out),
            "highlight_consonants": cons_words,
        }
    )


def _fetch_root_constellation(db: sqlite3.Connection, root_str: str) -> Dict[str, Any]:
    rows = db.execute(
        """
        SELECT entry_id, word, binyan, binyan_group, is_aramaic, occurrences_count, verses_count
        FROM entries
        WHERE root = ?
        ORDER BY occurrences_count DESC, entry_id ASC;
        """,
        (root_str,),
    ).fetchall()

    grouped: Dict[Tuple[str, str, int], Dict[str, Any]] = {}
    total_occ = 0
    for r in rows:
        total_occ += r["occurrences_count"]
        gkey = (r["binyan"], r["binyan_group"], r["is_aramaic"])
        bucket = grouped.get(gkey)
        if bucket is None:
            bucket = {
                "binyan": r["binyan"],
                "binyan_group": r["binyan_group"],
                "is_aramaic": r["is_aramaic"],
                "total_occurrences": 0,
                "forms_count": 0,
                "top_words": [],
            }
            grouped[gkey] = bucket
        bucket["total_occurrences"] += r["occurrences_count"]
        bucket["forms_count"] += 1
        if len(bucket["top_words"]) < 8:
            bucket["top_words"].append(
                {
                    "entry_id": r["entry_id"],
                    "word": r["word"],
                    "occurrences_count": r["occurrences_count"],
                    "binyan": r["binyan"],
                    "binyan_group": r["binyan_group"],
                }
            )

    binyanim = sorted(
        grouped.values(),
        key=lambda b: (b["binyan_group"] == "none", -b["total_occurrences"]),
    )
    return {
        "mode": "root",
        "center_label": root_str,
        "total_occurrences": total_occ,
        "total_forms": len(rows),
        "binyanim": binyanim,
    }


def _fetch_collocations(
    db: sqlite3.Connection,
    entry_id: Optional[int] = None,
    root_str: Optional[str] = None,
) -> List[Dict[str, Any]]:
    if entry_id is not None:
        rows = db.execute(
            """
            WITH sample_verses AS (
                SELECT verse_id FROM occurrences WHERE entry_id = ? LIMIT 500
            )
            SELECT e2.entry_id, e2.word, e2.root, e2.binyan, e2.binyan_group,
                   e2.occurrences_count, COUNT(DISTINCT o2.verse_id) AS shared_verses
            FROM sample_verses sv
            JOIN occurrences o2 ON o2.verse_id = sv.verse_id
            JOIN entries e2 ON e2.entry_id = o2.entry_id
            WHERE o2.entry_id != ? AND e2.root != '-' AND e2.occurrences_count < 2500
            GROUP BY e2.entry_id
            ORDER BY shared_verses DESC, e2.occurrences_count ASC
            LIMIT 14;
            """,
            (entry_id, entry_id),
        ).fetchall()
    elif root_str:
        rows = db.execute(
            """
            WITH sample_verses AS (
                SELECT DISTINCT o.verse_id
                FROM occurrences o
                JOIN entries e ON e.entry_id = o.entry_id
                WHERE e.root = ?
                LIMIT 500
            )
            SELECT e2.entry_id, e2.word, e2.root, e2.binyan, e2.binyan_group,
                   e2.occurrences_count, COUNT(DISTINCT o2.verse_id) AS shared_verses
            FROM sample_verses sv
            JOIN occurrences o2 ON o2.verse_id = sv.verse_id
            JOIN entries e2 ON e2.entry_id = o2.entry_id
            WHERE e2.root != ? AND e2.root != '-' AND e2.occurrences_count < 2500
            GROUP BY e2.entry_id
            ORDER BY shared_verses DESC, e2.occurrences_count ASC
            LIMIT 14;
            """,
            (root_str, root_str),
        ).fetchall()
    else:
        return []
    return [_row_to_dict(r) for r in rows]


@app.route("/api/entry/<int:entry_id>")
def api_entry(entry_id: int) -> Any:
    db = get_db()
    row = db.execute("SELECT * FROM entries WHERE entry_id = ?;", (entry_id,)).fetchone()
    if row is None:
        abort(404)
    entry = _row_to_dict(row)

    rank = (
        db.execute(
            "SELECT COUNT(*) + 1 FROM entries WHERE occurrences_count > ?;",
            (entry["occurrences_count"],),
        ).fetchone()[0]
    )

    homographs = [
        _row_to_dict(r)
        for r in db.execute(
            "SELECT entry_id, word, root, binyan, binyan_group, occurrences_count, verses_count "
            "FROM entries WHERE word = ? AND entry_id != ? ORDER BY occurrences_count DESC;",
            (entry["word"], entry_id),
        ).fetchall()
    ]

    niqqud_twins = [
        _row_to_dict(r)
        for r in db.execute(
            "SELECT entry_id, word, root, binyan, binyan_group, occurrences_count "
            "FROM entries WHERE consonants = ? AND word != ? "
            "ORDER BY occurrences_count DESC LIMIT 12;",
            (entry["consonants"], entry["word"]),
        ).fetchall()
    ]

    book_distribution = [
        _row_to_dict(r)
        for r in db.execute(
            "SELECT book_id, SUM(count_in_verse) AS count "
            "FROM occurrences WHERE entry_id = ? GROUP BY book_id ORDER BY book_id;",
            (entry_id,),
        ).fetchall()
    ]

    if entry["root"] != "-":
        graph = _fetch_root_constellation(db, entry["root"])
    else:
        siblings = [
            _row_to_dict(r)
            for r in db.execute(
                """
                SELECT entry_id, word, root, binyan, binyan_group, occurrences_count, verses_count
                FROM entries
                WHERE consonants = ? OR (consonants LIKE ? AND LENGTH(consonants) <= LENGTH(?) + 2)
                ORDER BY occurrences_count DESC
                LIMIT 20;
                """,
                (entry["consonants"], f"%{entry['consonants']}", entry["consonants"]),
            ).fetchall()
        ]
        graph = {
            "mode": "consonants",
            "center_label": entry["word"],
            "total_occurrences": sum(s["occurrences_count"] for s in siblings),
            "total_forms": len(siblings),
            "binyanim": [
                {
                    "binyan": "צורות דומות",
                    "binyan_group": "none",
                    "is_aramaic": entry["is_aramaic"],
                    "total_occurrences": sum(s["occurrences_count"] for s in siblings),
                    "forms_count": len(siblings),
                    "top_words": siblings[:14],
                }
            ],
        }

    collocations = _fetch_collocations(db, entry_id=entry_id)

    return jsonify(
        {
            "entry": entry,
            "rank": rank,
            "homographs": homographs,
            "niqqud_twins": niqqud_twins,
            "book_distribution": book_distribution,
            "graph": graph,
            "collocations": collocations,
        }
    )


@app.route("/api/root/<path:root_str>")
def api_root(root_str: str) -> Any:
    db = get_db()
    root_clean = root_str.strip()
    if "." not in root_clean:
        letters = strip_to_consonants(root_clean).translate(FINAL_TO_MEDIAL)
        if letters:
            root_clean = ".".join(letters)

    graph = _fetch_root_constellation(db, root_clean)
    if graph["total_forms"] == 0:
        abort(404)

    verses_total = db.execute(
        """
        SELECT COUNT(DISTINCT o.verse_id)
        FROM occurrences o
        JOIN entries e ON e.entry_id = o.entry_id
        WHERE e.root = ?;
        """,
        (root_clean,),
    ).fetchone()[0]

    book_distribution = [
        _row_to_dict(r)
        for r in db.execute(
            """
            SELECT o.book_id, SUM(o.count_in_verse) AS count
            FROM occurrences o
            JOIN entries e ON e.entry_id = o.entry_id
            WHERE e.root = ?
            GROUP BY o.book_id
            ORDER BY o.book_id;
            """,
            (root_clean,),
        ).fetchall()
    ]

    collocations = _fetch_collocations(db, root_str=root_clean)

    return jsonify(
        {
            "root": root_clean,
            "total_occurrences": graph["total_occurrences"],
            "total_forms": graph["total_forms"],
            "total_verses": verses_total,
            "book_distribution": book_distribution,
            "graph": graph,
            "collocations": collocations,
        }
    )


@app.route("/api/occurrences")
def api_occurrences() -> Any:
    db = get_db()
    entry_id_raw = (request.args.get("entry_id") or "").strip()
    root_str = (request.args.get("root") or "").strip()
    with_eid_raw = (request.args.get("with_entry_id") or "").strip()
    binyan = (request.args.get("binyan") or "all").strip()
    division = (request.args.get("division") or "all").strip()
    book_id_raw = (request.args.get("book_id") or "").strip()
    limit = min(max(int(request.args.get("limit") or 25), 1), 100)
    offset = max(int(request.args.get("offset") or 0), 0)

    entry_id = int(entry_id_raw) if entry_id_raw.isdigit() else None
    with_eid = int(with_eid_raw) if with_eid_raw.isdigit() else None
    book_id = int(book_id_raw) if book_id_raw.isdigit() else None

    if entry_id is None and not root_str:
        abort(400)

    joins: List[str] = [
        "JOIN verses v ON v.verse_id = o.verse_id",
        "JOIN books b ON b.book_id = o.book_id",
    ]
    where: List[str] = []
    params: List[Any] = []
    highlight_eids: List[int] = []

    if entry_id is not None:
        where.append("o.entry_id = ?")
        params.append(entry_id)
        highlight_eids = [entry_id]
    else:
        joins.insert(0, "JOIN entries e ON e.entry_id = o.entry_id")
        where.append("e.root = ?")
        params.append(root_str)
        e_where = ["root = ?"]
        e_params: List[Any] = [root_str]
        _apply_binyan_filter(where, params, binyan, "e")
        _apply_binyan_filter(e_where, e_params, binyan, "entries")
        highlight_eids = [
            r[0]
            for r in db.execute(
                f"SELECT entry_id FROM entries WHERE {' AND '.join(e_where)};",
                tuple(e_params),
            ).fetchall()
        ]

    if with_eid is not None:
        where.append(
            "EXISTS (SELECT 1 FROM occurrences ow WHERE ow.verse_id = o.verse_id AND ow.entry_id = ?)"
        )
        params.append(with_eid)

    if book_id is not None:
        where.append("o.book_id = ?")
        params.append(book_id)
    elif division and division != "all":
        where.append("b.division = ?")
        params.append(division)

    join_sql = " ".join(joins)
    where_sql = "WHERE " + " AND ".join(where)

    totals = db.execute(
        f"SELECT COUNT(DISTINCT o.verse_id) AS tv, COALESCE(SUM(o.count_in_verse), 0) AS tocc "
        f"FROM occurrences o {join_sql} {where_sql};",
        tuple(params),
    ).fetchone()

    rows = db.execute(
        f"""
        SELECT v.verse_id, v.book_id, v.chapter, v.verse, v.ref_he, v.tokens_json,
               SUM(o.count_in_verse) AS count_in_verse
        FROM occurrences o
        {join_sql}
        {where_sql}
        GROUP BY v.verse_id
        ORDER BY v.verse_id ASC
        LIMIT ? OFFSET ?;
        """,
        tuple(params + [limit, offset]),
    ).fetchall()

    verses_out: List[Dict[str, Any]] = []
    for r in rows:
        verses_out.append(
            {
                "verse_id": r["verse_id"],
                "book_id": r["book_id"],
                "chapter": r["chapter"],
                "verse": r["verse"],
                "ref_he": r["ref_he"],
                "count_in_verse": r["count_in_verse"],
                "tokens": json.loads(r["tokens_json"]),
            }
        )

    return jsonify(
        {
            "total_verses": totals["tv"],
            "total_occurrences": totals["tocc"],
            "verses": verses_out,
            "highlight_entry_ids": highlight_eids,
            "co_entry_ids": [with_eid] if with_eid is not None else [],
            "entry_meta": build_entry_meta(db, verses_out),
        }
    )


@app.route("/api/chapter/<int:book_id>/<int:chapter>")
def api_chapter(book_id: int, chapter: int) -> Any:
    db = get_db()
    book = db.execute("SELECT * FROM books WHERE book_id = ?;", (book_id,)).fetchone()
    if book is None:
        abort(404)

    max_chapter = db.execute(
        "SELECT MAX(chapter) FROM verses WHERE book_id = ?;", (book_id,)
    ).fetchone()[0]

    rows = db.execute(
        """
        SELECT verse_id, book_id, chapter, verse, ref_he, tokens_json
        FROM verses
        WHERE book_id = ? AND chapter = ?
        ORDER BY verse ASC;
        """,
        (book_id, chapter),
    ).fetchall()
    if not rows:
        abort(404)

    verses_out = [
        {
            "verse_id": r["verse_id"],
            "book_id": r["book_id"],
            "chapter": r["chapter"],
            "verse": r["verse"],
            "verse_gematria": to_gematria(r["verse"]),
            "ref_he": r["ref_he"],
            "tokens": json.loads(r["tokens_json"]),
        }
        for r in rows
    ]

    return jsonify(
        {
            "book": _row_to_dict(book),
            "chapter": chapter,
            "chapter_gematria": to_gematria(chapter),
            "max_chapter": max_chapter,
            "verses": verses_out,
            "entry_meta": build_entry_meta(db, verses_out),
        }
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8765, debug=False, threaded=True)
