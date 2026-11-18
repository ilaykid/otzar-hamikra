/* אוצר המקרא — 100% Static Client-Side Tanakh Concordance & Relationship Graph Engine */

const BINYAN_COLORS = {
  paal: "#3b5bdb",
  nifal: "#0d9488",
  piel: "#15803d",
  pual: "#0891b2",
  hifil: "#d97706",
  hufal: "#be123c",
  hitpael: "#7c3aed",
  none: "#64748b",
  aramaic: "#b91c1c",
};

const BINYAN_LABELS = {
  paal: "פָּעַל",
  nifal: "נִפְעַל",
  piel: "פִּעֵל",
  pual: "פֻּעַל",
  hifil: "הִפְעִיל",
  hufal: "הֻפְעַל",
  hitpael: "הִתְפַּעֵל",
  none: "ללא בניין",
};

const DIV_COLORS = {
  "תורה": "var(--div-torah)",
  "נביאים": "var(--div-neviim)",
  "כתובים": "var(--div-ketuvim)",
};

const SEP_FROM_CODE = [" ", "־", " ׀ ", "׃", ""];
const FINAL_MAP = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const GEMATRIA_HUNDREDS = { 100: "ק", 200: "ר", 300: "ש", 400: "ת" };
const GEMATRIA_TENS = {
  10: "י", 20: "כ", 30: "ל", 40: "מ", 50: "נ",
  60: "ס", 70: "ע", 80: "פ", 90: "צ",
};
const GEMATRIA_UNITS = {
  1: "א", 2: "ב", 3: "ג", 4: "ד", 5: "ה",
  6: "ו", 7: "ז", 8: "ח", 9: "ט",
};
const gematriaCache = new Map();

function toGematria(n) {
  const cached = gematriaCache.get(n);
  if (cached !== undefined) return cached;
  const letters = [];
  let rem = n;
  if (rem >= 100) {
    const h = Math.floor(rem / 100) * 100;
    letters.push(GEMATRIA_HUNDREDS[h]);
    rem %= 100;
  }
  if (rem === 15) {
    letters.push("ט", "ו");
  } else if (rem === 16) {
    letters.push("ט", "ז");
  } else {
    if (rem >= 10) {
      const t = Math.floor(rem / 10) * 10;
      letters.push(GEMATRIA_TENS[t]);
      rem %= 10;
    }
    if (rem > 0) letters.push(GEMATRIA_UNITS[rem]);
  }
  const res =
    letters.length === 1
      ? `${letters[0]}'`
      : `${letters.slice(0, -1).join("")}"${letters[letters.length - 1]}`;
  gematriaCache.set(n, res);
  return res;
}

function stripHebrewCons(str) {
  let out = "";
  for (const ch of str || "") {
    if (ch >= "\u05D0" && ch <= "\u05EA") out += ch;
  }
  return out;
}

function toMedial(str) {
  return str.replace(/[ךםןףץ]/g, (m) => FINAL_MAP[m]);
}

function hasNiqqud(str) {
  for (const ch of str || "") {
    const c = ch.charCodeAt(0);
    if (c >= 0x05B0 && c <= 0x05C7) return true;
  }
  return false;
}

function normalizeVocalizedWord(raw) {
  let out = "";
  for (const ch of raw || "") {
    if (ch === "/" || ch === "+" || /\s/.test(ch)) continue;
    let c = ch;
    if (c === "\u05C7") c = "\u05B8";
    else if (c === "\u05BA") c = "\u05B9";
    const code = c.charCodeAt(0);
    if (
      (code >= 0x05D0 && code <= 0x05EA) ||
      (code >= 0x05B0 && code <= 0x05BB) ||
      code === 0x05BC ||
      code === 0x05C1 ||
      code === 0x05C2
    ) {
      out += c;
    }
  }
  return out.normalize("NFC");
}

// ---------------- In-Memory Indexed Store ----------------

const db = {
  totals: null,
  books: [],
  bookById: new Map(),
  spotlights: null,
  entries: [], // 1-indexed objects
  verses: [], // 1-indexed objects
  occByEid: [], // 1-indexed array of packed numbers (vid * 32 + cnt)
  entriesByRoot: new Map(), // rootStr -> [eid...] sorted by occ DESC
  entriesByWord: new Map(), // word -> [eid...]
  entriesByCons: new Map(), // cons -> [eid...]
  rootsMeta: [], // [{root, rootPlain, forms, total_occ}] sorted by total_occ DESC
  freqSortedEids: null,
  rareSortedEids: null,
  rankOfEid: null,
  bookRange: new Map(),
  divRange: new Map(),
  chaptersIndex: new Map(), // `${bookId}:${chapter}` -> [vid...]
  maxChapterByBook: new Map(),
};

function buildClientIndex(meta, verseChunks) {
  db.totals = meta.totals;
  db.books = meta.books;
  db.spotlights = meta.spotlights;

  const divBounds = {
    "תורה": [Infinity, 0],
    "נביאים": [Infinity, 0],
    "כתובים": [Infinity, 0],
  };
  for (const b of meta.books) {
    db.bookById.set(b.book_id, b);
    db.bookRange.set(b.book_id, [b.min_vid, b.max_vid]);
    const dbn = divBounds[b.division];
    if (b.min_vid < dbn[0]) dbn[0] = b.min_vid;
    if (b.max_vid > dbn[1]) dbn[1] = b.max_vid;
  }
  for (const [k, v] of Object.entries(divBounds)) {
    db.divRange.set(k, v);
  }

  const nEntries = meta.entries.length - 1;
  db.entries = new Array(nEntries + 1);
  db.occByEid = new Array(nEntries + 1);
  const allEids = new Array(nEntries);
  const rootStats = new Map();

  for (let eid = 1; eid <= nEntries; eid++) {
    const [word, rootIdx, binyanIdx, occCnt, versesCnt] = meta.entries[eid];
    const root = meta.roots[rootIdx];
    const [binyan, binyan_group, is_aramaic] = meta.binyanim[binyanIdx];
    const consonants = stripHebrewCons(word);
    const consonants_norm = toMedial(consonants);

    const obj = {
      entry_id: eid,
      word,
      consonants,
      consonants_norm,
      root,
      root_plain: root === "-" ? "" : root.replace(/\./g, ""),
      binyan,
      binyan_group,
      is_aramaic,
      occurrences_count: occCnt,
      verses_count: versesCnt,
      first_ref: "",
    };
    db.entries[eid] = obj;
    db.occByEid[eid] = [];
    allEids[eid - 1] = eid;

    if (root !== "-") {
      let arr = db.entriesByRoot.get(root);
      if (!arr) {
        arr = [];
        db.entriesByRoot.set(root, arr);
        rootStats.set(root, { root, rootPlain: obj.root_plain, forms: 0, total_occ: 0 });
      }
      arr.push(eid);
      const rs = rootStats.get(root);
      rs.forms += 1;
      rs.total_occ += occCnt;
    }

    let wArr = db.entriesByWord.get(word);
    if (!wArr) {
      wArr = [];
      db.entriesByWord.set(word, wArr);
    }
    wArr.push(eid);

    let cArr = db.entriesByCons.get(consonants);
    if (!cArr) {
      cArr = [];
      db.entriesByCons.set(consonants, cArr);
    }
    cArr.push(eid);
  }

  for (const arr of db.entriesByRoot.values()) {
    arr.sort((a, b) => db.entries[b].occurrences_count - db.entries[a].occurrences_count || a - b);
  }
  for (const arr of db.entriesByWord.values()) {
    arr.sort((a, b) => db.entries[b].occurrences_count - db.entries[a].occurrences_count || a - b);
  }
  for (const arr of db.entriesByCons.values()) {
    arr.sort((a, b) => db.entries[b].occurrences_count - db.entries[a].occurrences_count || a - b);
  }

  db.rootsMeta = Array.from(rootStats.values()).sort(
    (a, b) => b.total_occ - a.total_occ || a.root.localeCompare(b.root)
  );

  // Frequency & rarity orderings + tie-aware global rank
  const freqArr = allEids.slice().sort(
    (a, b) => db.entries[b].occurrences_count - db.entries[a].occurrences_count || a - b
  );
  db.freqSortedEids = Int32Array.from(freqArr);
  db.rareSortedEids = Int32Array.from(
    allEids.slice().sort(
      (a, b) => db.entries[a].occurrences_count - db.entries[b].occurrences_count || a - b
    )
  );

  db.rankOfEid = new Int32Array(nEntries + 1);
  let prevOcc = -1;
  let prevRank = 1;
  for (let i = 0; i < freqArr.length; i++) {
    const eid = freqArr[i];
    const occ = db.entries[eid].occurrences_count;
    const rank = occ === prevOcc ? prevRank : i + 1;
    db.rankOfEid[eid] = rank;
    prevOcc = occ;
    prevRank = rank;
  }

  // Decode verses and build inverted occurrence lists (already sorted by verse_id!)
  db.verses = new Array(meta.totals.verses + 1);
  const verseCntTmp = new Map();

  for (const chunk of verseChunks) {
    for (const [vid, bookId, chapter, verse, rawTokens] of chunk) {
      const bookName = db.bookById.get(bookId).name_he;
      const ref_he = `${bookName}, ${toGematria(chapter)}, ${toGematria(verse)}`;
      const tokens = new Array(rawTokens.length);
      const consParts = new Array(rawTokens.length);
      verseCntTmp.clear();

      for (let ti = 0; ti < rawTokens.length; ti++) {
        const rt = rawTokens[ti];
        const eid = rt[0];
        const wVoc = db.entries[eid].word;
        const wCant = rt[1] ? rt[1] : wVoc;
        const sep = SEP_FROM_CODE[rt.length > 2 ? rt[2] : 0];
        tokens[ti] = [eid, wVoc, wCant, sep];
        consParts[ti] = db.entries[eid].consonants;
        verseCntTmp.set(eid, (verseCntTmp.get(eid) || 0) + 1);
      }

      for (const [eid, cnt] of verseCntTmp.entries()) {
        const list = db.occByEid[eid];
        if (list.length === 0) {
          db.entries[eid].first_ref = ref_he;
        }
        list.push(vid * 32 + cnt);
      }

      db.verses[vid] = {
        verse_id: vid,
        book_id: bookId,
        chapter,
        verse,
        verse_gematria: toGematria(verse),
        ref_he,
        tokens,
        consText: consParts.join(" "),
      };

      const ck = `${bookId}:${chapter}`;
      let chArr = db.chaptersIndex.get(ck);
      if (!chArr) {
        chArr = [];
        db.chaptersIndex.set(ck, chArr);
      }
      chArr.push(vid);
      const prevMax = db.maxChapterByBook.get(bookId) || 0;
      if (chapter > prevMax) db.maxChapterByBook.set(bookId, chapter);
    }
  }
}

// ---------------- Local Query Functions (1:1 API Parity) ----------------

function hasOccurrenceInRange(packedList, minVid, maxVid) {
  let lo = 0;
  let hi = packedList.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const vid = Math.floor(packedList[mid] / 32);
    if (vid < minVid) lo = mid + 1;
    else if (vid > maxVid) hi = mid - 1;
    else return true;
  }
  return false;
}

function matchesBinyan(entry, binyan) {
  if (!binyan || binyan === "all") return true;
  if (binyan === "aramaic") return entry.is_aramaic === 1;
  return entry.binyan_group === binyan;
}

function buildEntryMetaForVerses(verses) {
  const meta = {};
  for (const v of verses) {
    for (const tok of v.tokens) {
      const eid = tok[0];
      if (!meta[eid]) {
        const e = db.entries[eid];
        meta[eid] = [e.word, e.root, e.binyan, e.occurrences_count];
      }
    }
  }
  return meta;
}

function localSearch({ q, binyan, division, bookId, sort, limit, offset }) {
  const qRaw = (q || "").trim();
  let vidRange = null;
  if (bookId) vidRange = db.bookRange.get(bookId);
  else if (division && division !== "all") vidRange = db.divRange.get(division);

  let matchedRoots = [];
  let baseIter;
  if (sort === "alpha") {
    baseIter = null; // 1..N
  } else if (sort === "rare") {
    baseIter = db.rareSortedEids;
  } else {
    baseIter = db.freqSortedEids;
  }

  let qVoc = "";
  let qCons = "";
  let qMed = "";
  const useNiqqud = qRaw && hasNiqqud(qRaw);
  if (qRaw) {
    if (useNiqqud) {
      qVoc = normalizeVocalizedWord(qRaw);
      qCons = stripHebrewCons(qVoc);
      qMed = toMedial(qCons);
    } else {
      qCons = stripHebrewCons(qRaw);
      qMed = toMedial(qCons);
    }
    if (qMed) {
      const exactRoots = [];
      const prefixRoots = [];
      for (const rm of db.rootsMeta) {
        if (rm.rootPlain === qMed) exactRoots.push(rm);
        else if (rm.rootPlain.startsWith(qMed)) prefixRoots.push(rm);
      }
      matchedRoots = exactRoots.concat(prefixRoots).slice(0, 5);
    }
  }

  const buckets = qRaw && (useNiqqud ? qVoc : qCons) ? [[], [], [], []] : [[]];
  const n = db.entries.length - 1;

  for (let idx = 0; idx < n; idx++) {
    const eid = baseIter ? baseIter[idx] : idx + 1;
    const e = db.entries[eid];
    if (!matchesBinyan(e, binyan)) continue;
    if (vidRange && !hasOccurrenceInRange(db.occByEid[eid], vidRange[0], vidRange[1])) {
      continue;
    }

    if (useNiqqud && qVoc) {
      if (e.word === qVoc) buckets[0].push(e);
      else if (e.word.startsWith(qVoc)) buckets[1].push(e);
    } else if (qRaw && qCons) {
      if (e.consonants === qCons) buckets[0].push(e);
      else if (e.root_plain === qMed) buckets[1].push(e);
      else if (e.consonants.startsWith(qCons)) buckets[2].push(e);
      else if (e.consonants_norm.startsWith(qMed)) buckets[3].push(e);
    } else {
      buckets[0].push(e);
    }
  }

  const matched = buckets.length === 1 ? buckets[0] : [].concat(...buckets);
  return {
    total: matched.length,
    items: matched.slice(offset, offset + limit),
    matched_roots: matchedRoots,
  };
}

function localVersesSearch({ q, division, bookId, limit, offset }) {
  const rawWords = (q || "").trim().replace(/־/g, " ").split(/\s+/).filter(Boolean);
  const consWords = rawWords.map(stripHebrewCons).filter(Boolean);
  if (!consWords.length) {
    return { total: 0, verses: [], entry_meta: {}, highlight_consonants: [] };
  }
  const phrase = consWords.join(" ");
  let minVid = 1;
  let maxVid = db.verses.length - 1;
  if (bookId) [minVid, maxVid] = db.bookRange.get(bookId);
  else if (division && division !== "all") [minVid, maxVid] = db.divRange.get(division);

  const hits = [];
  for (let vid = minVid; vid <= maxVid; vid++) {
    const v = db.verses[vid];
    if (v.consText.includes(phrase)) hits.push(v);
  }
  const slice = hits.slice(offset, offset + limit);
  return {
    total: hits.length,
    verses: slice,
    entry_meta: buildEntryMetaForVerses(slice),
    highlight_consonants: consWords,
  };
}

function buildRootConstellationData(rootStr) {
  const eids = db.entriesByRoot.get(rootStr) || [];
  const grouped = new Map();
  let totalOcc = 0;

  for (const eid of eids) {
    const e = db.entries[eid];
    totalOcc += e.occurrences_count;
    const gkey = `${e.binyan}|${e.binyan_group}|${e.is_aramaic}`;
    let bucket = grouped.get(gkey);
    if (!bucket) {
      bucket = {
        binyan: e.binyan,
        binyan_group: e.binyan_group,
        is_aramaic: e.is_aramaic,
        total_occurrences: 0,
        forms_count: 0,
        top_words: [],
      };
      grouped.set(gkey, bucket);
    }
    bucket.total_occurrences += e.occurrences_count;
    bucket.forms_count += 1;
    if (bucket.top_words.length < 8) {
      bucket.top_words.push({
        entry_id: e.entry_id,
        word: e.word,
        occurrences_count: e.occurrences_count,
        binyan: e.binyan,
        binyan_group: e.binyan_group,
      });
    }
  }

  const binyanim = Array.from(grouped.values()).sort((a, b) => {
    const aNone = a.binyan_group === "none" ? 1 : 0;
    const bNone = b.binyan_group === "none" ? 1 : 0;
    return aNone - bNone || b.total_occurrences - a.total_occurrences;
  });

  return {
    mode: "root",
    center_label: rootStr,
    total_occurrences: totalOcc,
    total_forms: eids.length,
    binyanim,
  };
}

function computeCollocationsFromVids(sampleVids, excludeEid, excludeRoot) {
  const counts = new Map();
  const seenInVerse = new Set();

  for (const vid of sampleVids) {
    const v = db.verses[vid];
    seenInVerse.clear();
    for (const tok of v.tokens) {
      const eid2 = tok[0];
      if (eid2 === excludeEid || seenInVerse.has(eid2)) continue;
      seenInVerse.add(eid2);
      const e2 = db.entries[eid2];
      if (e2.root === "-" || (excludeRoot && e2.root === excludeRoot) || e2.occurrences_count >= 2500) {
        continue;
      }
      counts.set(eid2, (counts.get(eid2) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => {
      const diff = b[1] - a[1];
      if (diff !== 0) return diff;
      return db.entries[a[0]].occurrences_count - db.entries[b[0]].occurrences_count;
    })
    .slice(0, 14)
    .map(([eid2, shared]) => {
      const e2 = db.entries[eid2];
      return {
        entry_id: e2.entry_id,
        word: e2.word,
        root: e2.root,
        binyan: e2.binyan,
        binyan_group: e2.binyan_group,
        occurrences_count: e2.occurrences_count,
        shared_verses: shared,
      };
    });
}

function computeBookDistribution(eids) {
  const map = new Map();
  for (const eid of eids) {
    for (const packed of db.occByEid[eid]) {
      const vid = Math.floor(packed / 32);
      const cnt = packed % 32;
      const bid = db.verses[vid].book_id;
      map.set(bid, (map.get(bid) || 0) + cnt);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([book_id, count]) => ({ book_id, count }));
}

function localGetEntry(entryId) {
  const e = db.entries[entryId];
  const rank = db.rankOfEid[entryId];

  const homographs = (db.entriesByWord.get(e.word) || [])
    .filter((id) => id !== entryId)
    .map((id) => db.entries[id]);

  const niqqud_twins = (db.entriesByCons.get(e.consonants) || [])
    .filter((id) => db.entries[id].word !== e.word)
    .slice(0, 12)
    .map((id) => db.entries[id]);

  const book_distribution = computeBookDistribution([entryId]);

  let graph;
  if (e.root !== "-") {
    graph = buildRootConstellationData(e.root);
  } else {
    const siblings = [];
    const seen = new Set();
    for (const id of db.entriesByCons.get(e.consonants) || []) {
      siblings.push(db.entries[id]);
      seen.add(id);
    }
    if (siblings.length < 20) {
      for (const eid of db.freqSortedEids) {
        if (seen.has(eid)) continue;
        const cand = db.entries[eid];
        if (
          cand.consonants.includes(e.consonants) &&
          cand.consonants.length <= e.consonants.length + 2
        ) {
          siblings.push(cand);
          seen.add(eid);
          if (siblings.length >= 20) break;
        }
      }
    }
    graph = {
      mode: "consonants",
      center_label: e.word,
      total_occurrences: siblings.reduce((s, x) => s + x.occurrences_count, 0),
      total_forms: siblings.length,
      binyanim: [
        {
          binyan: "צורות דומות",
          binyan_group: "none",
          is_aramaic: e.is_aramaic,
          total_occurrences: siblings.reduce((s, x) => s + x.occurrences_count, 0),
          forms_count: siblings.length,
          top_words: siblings.slice(0, 14),
        },
      ],
    };
  }

  const sampleVids = db.occByEid[entryId].slice(0, 500).map((p) => Math.floor(p / 32));
  const collocations = computeCollocationsFromVids(sampleVids, entryId, null);

  return {
    entry: e,
    rank,
    homographs,
    niqqud_twins,
    book_distribution,
    graph,
    collocations,
  };
}

function localGetRoot(rootStr) {
  let rootClean = (rootStr || "").trim();
  if (!rootClean.includes(".")) {
    const med = toMedial(stripHebrewCons(rootClean));
    if (med) rootClean = Array.from(med).join(".");
  }
  const eids = db.entriesByRoot.get(rootClean) || [];
  const graph = buildRootConstellationData(rootClean);
  const verseSet = new Set();
  for (const eid of eids) {
    for (const packed of db.occByEid[eid]) {
      verseSet.add(Math.floor(packed / 32));
    }
  }
  const sampleVids = Array.from(verseSet).slice(0, 500);
  return {
    root: rootClean,
    total_occurrences: graph.total_occurrences,
    total_forms: graph.total_forms,
    total_verses: verseSet.size,
    book_distribution: computeBookDistribution(eids),
    graph,
    collocations: computeCollocationsFromVids(sampleVids, null, rootClean),
  };
}

function localGetOccurrences({ entryId, root, withEntryId, binyan, division, bookId, limit, offset }) {
  let minVid = 1;
  let maxVid = db.verses.length - 1;
  if (bookId) [minVid, maxVid] = db.bookRange.get(bookId);
  else if (division && division !== "all") [minVid, maxVid] = db.divRange.get(division);

  let withSet = null;
  if (withEntryId) {
    withSet = new Set(db.occByEid[withEntryId].map((p) => Math.floor(p / 32)));
  }

  let highlightEids = [];
  let verseCountPairs = []; // [vid, countInVerse]

  if (entryId) {
    highlightEids = [entryId];
    for (const packed of db.occByEid[entryId]) {
      const vid = Math.floor(packed / 32);
      if (vid < minVid || vid > maxVid) continue;
      if (withSet && !withSet.has(vid)) continue;
      verseCountPairs.push([vid, packed % 32]);
    }
  } else if (root) {
    const matchingEids = (db.entriesByRoot.get(root) || []).filter((id) =>
      matchesBinyan(db.entries[id], binyan)
    );
    highlightEids = matchingEids;
    const vMap = new Map();
    for (const eid of matchingEids) {
      for (const packed of db.occByEid[eid]) {
        const vid = Math.floor(packed / 32);
        if (vid < minVid || vid > maxVid) continue;
        if (withSet && !withSet.has(vid)) continue;
        vMap.set(vid, (vMap.get(vid) || 0) + (packed % 32));
      }
    }
    verseCountPairs = Array.from(vMap.entries()).sort((a, b) => a[0] - b[0]);
  }

  let totalOcc = 0;
  for (const [, cnt] of verseCountPairs) totalOcc += cnt;

  const slice = verseCountPairs.slice(offset, offset + limit).map(([vid, cnt]) => ({
    ...db.verses[vid],
    count_in_verse: cnt,
  }));

  return {
    total_verses: verseCountPairs.length,
    total_occurrences: totalOcc,
    verses: slice,
    highlight_entry_ids: highlightEids,
    co_entry_ids: withEntryId ? [withEntryId] : [],
    entry_meta: buildEntryMetaForVerses(slice),
  };
}

function localGetChapter(bookId, chapter) {
  const vids = db.chaptersIndex.get(`${bookId}:${chapter}`) || [];
  const verses = vids.map((vid) => db.verses[vid]);
  return {
    book: db.bookById.get(bookId),
    chapter,
    chapter_gematria: toGematria(chapter),
    max_chapter: db.maxChapterByBook.get(bookId) || 1,
    verses,
    entry_meta: buildEntryMetaForVerses(verses),
  };
}

// ---------------- UI State & Renderers ----------------

const state = {
  mode: "words",
  q: "",
  binyan: "all",
  division: "all",
  bookId: null,
  sort: "freq",
  showCantillation: false,
  searchOffset: 0,
  searchItems: [],
  searchTotal: 0,

  activeTarget: null,
  entryData: null,
  rootData: null,
  vizTab: "constellation",
  zoom: 1,

  verseFilterBinyan: "all",
  verseFilterBookId: null,
  verseWithEntryId: null,
  verseWithLabel: "",
  verseOffset: 0,
  versesData: [],
  versesMeta: {},
  versesHighlightEids: new Set(),
  versesCoEids: new Set(),
  versesTotal: 0,
  versesOccTotal: 0,

  phraseOffset: 0,
  phraseVerses: [],
  phraseMeta: {},
  phraseHighlightCons: new Set(),
  phraseTotal: 0,

  drawerBookId: null,
  drawerChapter: null,
  drawerFocusVerse: null,
  drawerMaxChapter: 1,
  drawerMeta: {},
};

const el = (id) => document.getElementById(id);

function fmtNum(n) {
  return Number(n || 0).toLocaleString("he-IL");
}

function binyanColor(group, isAramaic) {
  if (isAramaic && group === "none") return BINYAN_COLORS.aramaic;
  return BINYAN_COLORS[group] || BINYAN_COLORS.none;
}

function binyanPillHtml(binyanStr, group, isAramaic) {
  const col = binyanColor(group, isAramaic);
  const label = binyanStr === "-" ? "ללא בניין" : binyanStr;
  return `<span class="binyan-tag" style="background:${col}">${escapeHtml(label)}</span>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function init() {
  bindEvents();
  try {
    const [meta, v1, v2, v3] = await Promise.all([
      fetch("./data/meta.json").then((r) => r.json()),
      fetch("./data/verses_1.json").then((r) => r.json()),
      fetch("./data/verses_2.json").then((r) => r.json()),
      fetch("./data/verses_3.json").then((r) => r.json()),
    ]);
    el("bootStatusText").textContent = "בונה אינדקס מהיר בזיכרון...";
    buildClientIndex(meta, [v1, v2, v3]);

    const t = db.totals;
    el("corpusStats").textContent =
      `${fmtNum(t.tokens)} מופעים · ${fmtNum(t.entries)} צורות מנוקדות · ${fmtNum(t.roots)} שורשים · ${fmtNum(t.verses)} פסוקים`;
    populateBookSelect(db.books);
    runSearch(true);

    const hash = decodeURIComponent(window.location.hash || "");
    if (hash.startsWith("#entry=")) {
      const eid = Number(hash.slice(7));
      if (db.entries[eid]) selectEntry(eid);
      else selectRoot(db.spotlights.default_root);
    } else if (hash.startsWith("#root=")) {
      const r = hash.slice(6);
      if (db.entriesByRoot.has(r)) selectRoot(r);
      else selectRoot(db.spotlights.default_root);
    } else {
      selectRoot(db.spotlights.default_root);
    }
    el("appBootLoader").classList.add("hidden");
  } catch (err) {
    el("bootStatusText").textContent = `שגיאה בטעינת הנתונים: ${err.message}`;
  }
}

function populateBookSelect(books) {
  const select = el("bookFilter");
  const groups = { "תורה": [], "נביאים": [], "כתובים": [] };
  for (const b of books) {
    if (groups[b.division]) groups[b.division].push(b);
  }
  for (const [divName, list] of Object.entries(groups)) {
    const og = document.createElement("optgroup");
    og.label = divName;
    for (const b of list) {
      const opt = document.createElement("option");
      opt.value = `book:${b.book_id}`;
      opt.textContent = b.name_he;
      og.appendChild(opt);
    }
    select.appendChild(og);
  }
}

let searchTimer = null;

function bindEvents() {
  el("modeWordsBtn").addEventListener("click", () => switchMode("words"));
  el("modeVersesBtn").addEventListener("click", () => switchMode("verses"));

  el("searchInput").addEventListener("input", (e) => {
    state.q = e.target.value;
    el("clearSearchBtn").classList.toggle("hidden", !state.q);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.mode === "words") runSearch(true);
      else runPhraseSearch(true);
    }, 120);
  });

  el("clearSearchBtn").addEventListener("click", () => {
    state.q = "";
    el("searchInput").value = "";
    el("clearSearchBtn").classList.add("hidden");
    if (state.mode === "words") runSearch(true);
    else runPhraseSearch(true);
  });

  el("cantillationToggle").addEventListener("click", () => {
    state.showCantillation = !state.showCantillation;
    el("cantillationToggle").setAttribute("aria-pressed", String(state.showCantillation));
    renderVersesList();
    if (state.mode === "verses") renderPhraseVerses();
    if (!el("chapterDrawer").classList.contains("hidden")) {
      loadChapter(state.drawerBookId, state.drawerChapter, state.drawerFocusVerse);
    }
  });

  el("themeToggle").addEventListener("click", () => {
    const isDark = document.body.getAttribute("data-theme") === "dark";
    document.body.setAttribute("data-theme", isDark ? "light" : "dark");
    el("themeIcon").textContent = isDark ? "🌙" : "☀️";
    el("themeLabel").textContent = isDark ? "מצב לילה" : "מצב קלף";
  });

  document.querySelectorAll(".spot-chip").forEach((btn) => {
    btn.addEventListener("click", () => handleSpotlight(btn.dataset.spot));
  });

  document.querySelectorAll(".binyan-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".binyan-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.binyan = btn.dataset.binyan;
      if (state.mode === "words") runSearch(true);
    });
  });

  el("bookFilter").addEventListener("change", (e) => {
    const val = e.target.value;
    if (val === "all") {
      state.division = "all";
      state.bookId = null;
    } else if (val.startsWith("div:")) {
      state.division = val.slice(4);
      state.bookId = null;
    } else if (val.startsWith("book:")) {
      state.division = "all";
      state.bookId = Number(val.slice(5));
    }
    if (state.mode === "words") runSearch(true);
    else runPhraseSearch(true);
  });

  el("sortFilter").addEventListener("change", (e) => {
    state.sort = e.target.value;
    if (state.mode === "words") runSearch(true);
  });

  el("loadMoreEntriesBtn").addEventListener("click", () => runSearch(false));
  el("loadMoreVersesBtn").addEventListener("click", () => loadOccurrences(false));
  el("loadMorePhraseBtn").addEventListener("click", () => runPhraseSearch(false));

  document.querySelectorAll(".viz-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchVizTab(tab.dataset.viz));
  });

  el("zoomInBtn").addEventListener("click", () => setZoom(state.zoom * 1.18));
  el("zoomOutBtn").addEventListener("click", () => setZoom(state.zoom / 1.18));
  el("zoomResetBtn").addEventListener("click", () => setZoom(1));

  [el("versesList"), el("phraseVersesList"), el("drawerBody")].forEach((container) => {
    container.addEventListener("click", (e) => {
      const chapBtn = e.target.closest(".chapter-open-btn");
      if (chapBtn) {
        loadChapter(
          Number(chapBtn.dataset.book),
          Number(chapBtn.dataset.chapter),
          Number(chapBtn.dataset.verse)
        );
        return;
      }
      const wSpan = e.target.closest(".v-word");
      if (wSpan && wSpan.dataset.eid) {
        hideTooltip();
        if (state.mode === "verses") switchMode("words");
        closeDrawer();
        selectEntry(Number(wSpan.dataset.eid));
      }
    });

    container.addEventListener("mousemove", (e) => {
      const wSpan = e.target.closest(".v-word");
      if (!wSpan || !wSpan.dataset.eid) {
        hideTooltip();
        return;
      }
      const metaSource =
        container === el("phraseVersesList")
          ? state.phraseMeta
          : container === el("drawerBody")
          ? state.drawerMeta
          : state.versesMeta;
      const info = metaSource?.[wSpan.dataset.eid];
      if (!info) return;
      showTooltip(e.clientX, e.clientY, info);
    });

    container.addEventListener("mouseleave", hideTooltip);
  });

  el("closeDrawerBtn").addEventListener("click", closeDrawer);
  el("drawerBackdrop").addEventListener("click", closeDrawer);
  el("prevChapBtn").addEventListener("click", () => {
    if (state.drawerChapter > 1) {
      loadChapter(state.drawerBookId, state.drawerChapter - 1, null);
    }
  });
  el("nextChapBtn").addEventListener("click", () => {
    if (state.drawerChapter < state.drawerMaxChapter) {
      loadChapter(state.drawerBookId, state.drawerChapter + 1, null);
    }
  });
}

function switchMode(mode) {
  state.mode = mode;
  el("modeWordsBtn").classList.toggle("active", mode === "words");
  el("modeVersesBtn").classList.toggle("active", mode === "verses");
  el("masterPane").classList.toggle("hidden", mode === "verses");
  document.querySelector(".workspace").classList.toggle("single-col", mode === "verses");
  el("binyanFilterGroup").classList.toggle("hidden", mode === "verses");
  el("sortFilter").classList.toggle("hidden", mode === "verses");
  el("explorerView").classList.toggle("hidden", mode === "verses");
  el("verseSearchView").classList.toggle("hidden", mode === "words");
  el("searchInput").placeholder =
    mode === "words"
      ? "חפש מילה (עם או בלי ניקוד), שורש (ה.ל.כ / הלך)..."
      : "חפש ביטוי בפסוקי התנ\"ך (למשל: תהו ובהו, על פני תהום)...";
  if (mode === "verses") runPhraseSearch(true);
}

function handleSpotlight(code) {
  if (state.mode !== "words") switchMode("words");
  const sp = db.spotlights || {};
  if (code.startsWith("root:")) {
    const r = code.slice(5);
    state.q = r;
    el("searchInput").value = r;
    el("clearSearchBtn").classList.remove("hidden");
    runSearch(true);
    selectRoot(r);
  } else if (code === "entry:banu" && sp.banu_entry_id) {
    state.q = "בנו";
    el("searchInput").value = "בנו";
    el("clearSearchBtn").classList.remove("hidden");
    runSearch(true);
    selectEntry(sp.banu_entry_id);
  } else if (code === "entry:kol" && sp.kol_qamats_id) {
    state.q = "כל";
    el("searchInput").value = "כל";
    el("clearSearchBtn").classList.remove("hidden");
    runSearch(true);
    selectEntry(sp.kol_qamats_id);
  } else if (code === "rare") {
    state.q = "";
    el("searchInput").value = "";
    el("clearSearchBtn").classList.add("hidden");
    state.sort = "rare";
    el("sortFilter").value = "rare";
    runSearch(true);
    if (state.searchItems.length > 0) selectEntry(state.searchItems[0].entry_id);
  }
}

function runSearch(reset) {
  if (reset) {
    state.searchOffset = 0;
    state.searchItems = [];
  }
  const data = localSearch({
    q: state.q,
    binyan: state.binyan,
    division: state.division,
    bookId: state.bookId,
    sort: state.sort,
    limit: 70,
    offset: state.searchOffset,
  });
  state.searchTotal = data.total;
  state.searchItems = reset ? data.items : state.searchItems.concat(data.items);
  state.searchOffset = state.searchItems.length;

  renderMatchedRoots(data.matched_roots || []);
  renderResultsList();
}

function renderMatchedRoots(roots) {
  const box = el("matchedRootsBox");
  if (!roots.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML =
    `<div class="strip-label">שורשים תואמים — לחץ למפת משפחת השורש:</div>` +
    roots
      .map(
        (r) => `
      <button class="root-hit-btn" data-root="${escapeHtml(r.root)}">
        <span>שורש <strong class="he-serif">${escapeHtml(r.root)}</strong></span>
        <span>${fmtNum(r.forms)} צורות · ${fmtNum(r.total_occ)} מופעים</span>
      </button>`
      )
      .join("");
  box.querySelectorAll(".root-hit-btn").forEach((b) => {
    b.addEventListener("click", () => selectRoot(b.dataset.root));
  });
}

function renderResultsList() {
  el("resultsCountLabel").textContent = `נמצאו ${fmtNum(state.searchTotal)} צורות מילה`;
  const list = el("resultsList");
  const activeEid = state.activeTarget?.type === "entry" ? state.activeTarget.entryId : null;

  if (!state.searchItems.length) {
    list.innerHTML = `<div class="empty-state">לא נמצאו מילים התואמות לסינון הנוכחי.</div>`;
  } else {
    list.innerHTML = state.searchItems
      .map((item) => {
        const isAct = activeEid === item.entry_id ? " active" : "";
        const rootTxt = item.root === "-" ? "ללא שורש" : `שורש ${item.root}`;
        return `
        <button class="entry-item${isAct}" data-eid="${item.entry_id}">
          <div class="entry-item-main">
            <span class="entry-item-word">${escapeHtml(item.word)}</span>
            <div class="entry-item-meta">
              <span>${escapeHtml(rootTxt)}</span>
              ${binyanPillHtml(item.binyan, item.binyan_group, item.is_aramaic)}
            </div>
          </div>
          <span class="entry-item-count">${fmtNum(item.occurrences_count)}</span>
        </button>`;
      })
      .join("");

    list.querySelectorAll(".entry-item").forEach((btn) => {
      btn.addEventListener("click", () => selectEntry(Number(btn.dataset.eid)));
    });
  }

  el("resultsMoreWrap").classList.toggle("hidden", state.searchItems.length >= state.searchTotal);
}

function selectEntry(entryId) {
  state.activeTarget = { type: "entry", entryId };
  state.verseFilterBinyan = "all";
  state.verseFilterBookId = null;
  state.verseWithEntryId = null;
  state.verseWithLabel = "";
  history.replaceState(null, "", `#entry=${entryId}`);

  const data = localGetEntry(entryId);
  state.entryData = data;
  state.rootData = null;

  renderResultsList();
  renderHeroForEntry(data);
  renderActiveViz(data.graph, data.collocations, data.book_distribution);
  loadOccurrences(true);
}

function selectRoot(rootStr) {
  state.activeTarget = { type: "root", root: rootStr };
  state.verseFilterBinyan = "all";
  state.verseFilterBookId = null;
  state.verseWithEntryId = null;
  state.verseWithLabel = "";
  history.replaceState(null, "", `#root=${encodeURIComponent(rootStr)}`);

  const data = localGetRoot(rootStr);
  state.rootData = data;
  state.entryData = null;

  renderResultsList();
  renderHeroForRoot(data);
  renderActiveViz(data.graph, data.collocations, data.book_distribution);
  loadOccurrences(true);
}

function renderHeroForEntry(data) {
  const e = data.entry;
  el("heroKindBadge").textContent = e.is_aramaic ? "צורת מילה (ארמית מקראית)" : "צורת מילה מנוקדת";
  el("heroTitle").textContent = e.word;
  el("metricOcc").textContent = fmtNum(e.occurrences_count);
  el("metricVerses").textContent = fmtNum(e.verses_count);
  el("metricForms").textContent = `#${fmtNum(data.rank)}`;
  el("metricFormsLbl").textContent = "דירוג שכיחות";

  let badges = "";
  if (e.root !== "-") {
    badges += `<button id="jumpRootBtn" class="badge clickable">שורש: <strong class="he-serif">${escapeHtml(e.root)}</strong> — לכל משפחת השורש ↗</button>`;
  } else {
    badges += `<span class="badge">שורש: —</span>`;
  }
  badges += binyanPillHtml(e.binyan, e.binyan_group, e.is_aramaic);
  badges += `<span class="badge">מופע ראשון: ${escapeHtml(e.first_ref)}</span>`;
  el("heroBadges").innerHTML = badges;

  const jr = el("jumpRootBtn");
  if (jr) jr.addEventListener("click", () => selectRoot(e.root));

  const hStrip = el("homographStrip");
  if (data.homographs && data.homographs.length > 0) {
    hStrip.classList.remove("hidden");
    hStrip.innerHTML =
      `<span class="strip-label">הומוגרפים בעלי ניקוד זהה (${data.homographs.length + 1} משמעויות):</span>` +
      data.homographs
        .map(
          (h) => `
        <button class="strip-chip" data-eid="${h.entry_id}">
          <span class="he-serif">${escapeHtml(h.word)}</span>
          <span>${h.root === "-" ? "ללא שורש" : escapeHtml(h.root)}</span>
          ${binyanPillHtml(h.binyan, h.binyan_group, h.is_aramaic)}
          <span>(${fmtNum(h.occurrences_count)})</span>
        </button>`
        )
        .join("");
    hStrip.querySelectorAll(".strip-chip").forEach((b) =>
      b.addEventListener("click", () => selectEntry(Number(b.dataset.eid)))
    );
  } else {
    hStrip.classList.add("hidden");
    hStrip.innerHTML = "";
  }

  const nStrip = el("niqqudTwinsStrip");
  if (data.niqqud_twins && data.niqqud_twins.length > 0) {
    nStrip.classList.remove("hidden");
    nStrip.innerHTML =
      `<span class="strip-label">אותן אותיות בניקוד שונה:</span>` +
      data.niqqud_twins
        .map(
          (tw) => `
        <button class="strip-chip" data-eid="${tw.entry_id}">
          <span class="he-serif">${escapeHtml(tw.word)}</span>
          <span>(${fmtNum(tw.occurrences_count)})</span>
        </button>`
        )
        .join("");
    nStrip.querySelectorAll(".strip-chip").forEach((b) =>
      b.addEventListener("click", () => selectEntry(Number(b.dataset.eid)))
    );
  } else {
    nStrip.classList.add("hidden");
    nStrip.innerHTML = "";
  }
}

function renderHeroForRoot(data) {
  el("heroKindBadge").textContent = "משפחת שורש מלאה";
  el("heroTitle").textContent = `שורש ${data.root}`;
  el("metricOcc").textContent = fmtNum(data.total_occurrences);
  el("metricVerses").textContent = fmtNum(data.total_verses);
  el("metricForms").textContent = fmtNum(data.total_forms);
  el("metricFormsLbl").textContent = "צורות מנוקדות";

  el("heroBadges").innerHTML = (data.graph?.binyanim || [])
    .map(
      (b) => `
      <button class="strip-chip root-binyan-btn" data-bgroup="${b.binyan_group}">
        ${binyanPillHtml(b.binyan, b.binyan_group, b.is_aramaic)}
        <span>${fmtNum(b.total_occurrences)} מופעים</span>
      </button>`
    )
    .join("");

  el("heroBadges").querySelectorAll(".root-binyan-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.verseFilterBinyan =
        state.verseFilterBinyan === btn.dataset.bgroup ? "all" : btn.dataset.bgroup;
      loadOccurrences(true);
    });
  });

  el("homographStrip").classList.add("hidden");
  el("niqqudTwinsStrip").classList.add("hidden");
}

function switchVizTab(tab) {
  state.vizTab = tab;
  document.querySelectorAll(".viz-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.viz === tab)
  );
  el("constellationWrap").classList.toggle("hidden", tab !== "constellation");
  el("collocationsWrap").classList.toggle("hidden", tab !== "collocations");
  el("distributionWrap").classList.toggle("hidden", tab !== "distribution");

  if (tab === "constellation") {
    el("vizHint").textContent = "לחץ על בניין לסינון הפסוקים או על מילה למעבר ישיר אליה";
  } else if (tab === "collocations") {
    el("vizHint").textContent = "לחץ על מילה נלווית כדי לראות רק את הפסוקים שבהם שתי המילים מופיעות יחד";
  } else {
    el("vizHint").textContent = "לחץ על ספר כדי לסנן את רשימת הפסוקים לאותו ספר";
  }
}

function renderActiveViz(graph, collocations, bookDist) {
  renderConstellationSvg(graph);
  renderCollocationsSvg(collocations || []);
  renderDistributionChart(bookDist || []);
}

function setZoom(z) {
  state.zoom = Math.max(0.65, Math.min(2.2, z));
  const svg = el("constellationSvg");
  const w = 920 / state.zoom;
  const h = 560 / state.zoom;
  const x = (920 - w) / 2;
  const y = (560 - h) / 2;
  svg.setAttribute("viewBox", `${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
}

function renderConstellationSvg(graph) {
  const svg = el("constellationSvg");
  setZoom(1);
  if (!graph || !graph.binyanim || !graph.binyanim.length) {
    svg.innerHTML = "";
    return;
  }

  const W = 920;
  const H = 560;
  const cx = W / 2;
  const cy = H / 2;
  const rBinyan = 112;
  const binyanim = graph.binyanim;

  el("constellationLegend").textContent =
    graph.mode === "root"
      ? `שורש ${graph.center_label} · ${fmtNum(graph.total_forms)} צורות · ${fmtNum(graph.total_occurrences)} מופעים`
      : `צורות קרובות עבור ${graph.center_label}`;

  const activeEid = state.activeTarget?.type === "entry" ? state.activeTarget.entryId : null;
  const displaySlices = binyanim.map((b) => {
    const rawWords = b.top_words || [];
    const cap = binyanim.length > 4 ? 5 : 6;
    let words = rawWords.slice(0, cap);
    if (activeEid && !words.some((w) => w.entry_id === activeEid)) {
      const match = rawWords.find((w) => w.entry_id === activeEid);
      if (match) words = words.slice(0, cap - 1).concat([match]);
    }
    return { b, words };
  });

  const weights = displaySlices.map((s) => Math.max(1.4, s.words.length + 0.8));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const wordNodes = [];
  const binyanNodes = [];
  let angleCursor = -Math.PI / 2;

  displaySlices.forEach(({ b, words }, idx) => {
    const span = (weights[idx] / totalWeight) * Math.PI * 2;
    const midAngle = angleCursor + span / 2;
    const bx = cx + Math.cos(midAngle) * rBinyan;
    const by = cy + Math.sin(midAngle) * rBinyan;
    const col = binyanColor(b.binyan_group, b.is_aramaic);
    const bLabel = b.binyan === "-" ? "ללא בניין" : b.binyan.replace(" (ארמית)", "");
    const bw = Math.max(76, bLabel.length * 8.5 + 18);

    binyanNodes.push({ b, bLabel, bw, bh: 32, x: bx, y: by, midAngle, col });

    const usableSpan = Math.max(0.28, span * 0.82);
    words.forEach((w, wi) => {
      const frac = words.length === 1 ? 0.5 : wi / (words.length - 1);
      const wa = midAngle - usableSpan / 2 + frac * usableSpan;
      const tier = words.length > 3 ? (wi % 2 === 0 ? 196 : 242) : 206;
      const wx = cx + Math.cos(wa) * tier;
      const wy = cy + Math.sin(wa) * tier;
      const pillW = Math.max(66, stripHebrewCons(w.word).length * 10.5 + 28);
      wordNodes.push({
        w,
        bx,
        by,
        wa,
        col,
        x: wx,
        y: wy,
        pw: pillW,
        ph: 27,
        isCur: activeEid === w.entry_id,
      });
    });

    angleCursor += span;
  });

  for (let iter = 0; iter < 32; iter++) {
    for (let i = 0; i < wordNodes.length; i++) {
      const a = wordNodes[i];
      for (let j = i + 1; j < wordNodes.length; j++) {
        const c = wordNodes[j];
        const minDx = (a.pw + c.pw) / 2 + 8;
        const minDy = (a.ph + c.ph) / 2 + 7;
        const dx = a.x - c.x;
        const dy = a.y - c.y;
        if (Math.abs(dx) < minDx && Math.abs(dy) < minDy) {
          const ox = minDx - Math.abs(dx);
          const oy = minDy - Math.abs(dy);
          if (ox < oy) {
            const sx = (dx >= 0 ? 1 : -1) * ox * 0.52;
            a.x += sx;
            c.x -= sx;
          } else {
            const sy = (dy >= 0 ? 1 : -1) * oy * 0.52;
            a.y += sy;
            c.y -= sy;
          }
        }
      }
      for (const bn of binyanNodes) {
        const minDx = (a.pw + bn.bw) / 2 + 10;
        const minDy = (a.ph + bn.bh) / 2 + 10;
        const dx = a.x - bn.x;
        const dy = a.y - bn.y;
        if (Math.abs(dx) < minDx && Math.abs(dy) < minDy) {
          const d = Math.hypot(dx, dy) || 1;
          a.x += (dx / d) * 8;
          a.y += (dy / d) * 8;
        }
      }
      a.x = Math.max(a.pw / 2 + 14, Math.min(W - a.pw / 2 - 14, a.x));
      a.y = Math.max(a.ph / 2 + 14, Math.min(H - a.ph / 2 - 14, a.y));
    }
  }

  let edgesHtml = "";
  let nodesHtml = "";

  for (const bn of binyanNodes) {
    const c1x = cx + Math.cos(bn.midAngle) * (rBinyan * 0.55);
    const c1y = cy + Math.sin(bn.midAngle) * (rBinyan * 0.55);
    edgesHtml += `<path class="svg-edge" d="M ${cx} ${cy} Q ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${bn.x.toFixed(1)} ${bn.y.toFixed(1)}" stroke="${bn.col}" stroke-width="3" stroke-opacity="0.45" />`;
  }

  for (const wn of wordNodes) {
    const ctrlX = (wn.bx + wn.x) / 2 + Math.cos(wn.wa) * 18;
    const ctrlY = (wn.by + wn.y) / 2 + Math.sin(wn.wa) * 18;
    edgesHtml += `<path class="svg-edge" d="M ${wn.bx.toFixed(1)} ${wn.by.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${wn.x.toFixed(1)} ${wn.y.toFixed(1)}" stroke="${wn.col}" stroke-width="${wn.isCur ? 2.6 : 1.5}" stroke-opacity="${wn.isCur ? 0.92 : 0.36}" />`;

    nodesHtml += `
      <g class="svg-node word-node" data-eid="${wn.w.entry_id}" transform="translate(${wn.x.toFixed(1)}, ${wn.y.toFixed(1)})">
        <rect x="${(-wn.pw / 2).toFixed(1)}" y="${(-wn.ph / 2).toFixed(1)}" width="${wn.pw.toFixed(1)}" height="${wn.ph}" rx="13.5"
          fill="${wn.isCur ? wn.col : "var(--bg-elevated)"}" stroke="${wn.col}" stroke-width="${wn.isCur ? 2.5 : 1.5}" />
        <text x="0" y="4.5" text-anchor="middle" direction="rtl"
          fill="${wn.isCur ? "#ffffff" : "var(--text)"}" font-family="Frank Ruhl Libre, serif" font-size="14.5" font-weight="700">${escapeHtml(wn.w.word)}</text>
      </g>`;
  }

  for (const bn of binyanNodes) {
    nodesHtml += `
      <g class="svg-node binyan-node" data-bgroup="${bn.b.binyan_group}" transform="translate(${bn.x.toFixed(1)}, ${bn.y.toFixed(1)})">
        <rect x="${(-bn.bw / 2).toFixed(1)}" y="-16" width="${bn.bw.toFixed(1)}" height="32" rx="16" fill="${bn.col}" stroke="#ffffff" stroke-width="2" />
        <text x="0" y="4" text-anchor="middle" direction="rtl" fill="#ffffff" font-family="Heebo, sans-serif" font-size="12.5" font-weight="700">${escapeHtml(bn.bLabel)}</text>
      </g>`;
  }

  nodesHtml += `
    <g class="svg-node center-node">
      <circle cx="${cx}" cy="${cy}" r="45" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="3" />
      <circle cx="${cx}" cy="${cy}" r="39" fill="var(--bg-elevated)" stroke="var(--accent)" stroke-width="1.2" />
      <text x="${cx}" y="${cy + 6}" text-anchor="middle" direction="rtl" fill="var(--text)"
        font-family="Frank Ruhl Libre, serif" font-size="22" font-weight="900">${escapeHtml(graph.center_label)}</text>
    </g>`;

  svg.innerHTML = `<g>${edgesHtml}</g><g>${nodesHtml}</g>`;

  svg.querySelectorAll(".word-node").forEach((n) => {
    n.addEventListener("click", () => selectEntry(Number(n.dataset.eid)));
  });
  svg.querySelectorAll(".binyan-node").forEach((n) => {
    n.addEventListener("click", () => {
      if (state.activeTarget?.type === "entry" && state.entryData?.entry?.root !== "-") {
        selectRoot(state.entryData.entry.root);
        state.verseFilterBinyan = n.dataset.bgroup;
        loadOccurrences(true);
      } else {
        state.verseFilterBinyan =
          state.verseFilterBinyan === n.dataset.bgroup ? "all" : n.dataset.bgroup;
        loadOccurrences(true);
      }
    });
  });
}

function renderCollocationsSvg(collocations) {
  const svg = el("collocationsSvg");
  const cx = 460;
  const cy = 250;
  const centerTxt =
    state.activeTarget?.type === "root"
      ? `שורש ${state.rootData?.root || ""}`
      : state.entryData?.entry?.word || "";

  if (!collocations.length) {
    svg.innerHTML = `<text x="${cx}" y="${cy}" text-anchor="middle" fill="var(--text-muted)" font-size="16">אין מספיק פסוקים משותפים להצגת רשת נלווים</text>`;
    return;
  }

  const maxShared = Math.max(...collocations.map((c) => c.shared_verses), 1);
  let edges = "";
  let nodes = "";

  collocations.forEach((c, idx) => {
    const angle = (idx / collocations.length) * Math.PI * 2 - Math.PI / 2;
    const rx = idx % 2 === 0 ? 325 : 225;
    const ry = idx % 2 === 0 ? 190 : 134;
    const nx = cx + Math.cos(angle) * rx;
    const ny = cy + Math.sin(angle) * ry;
    const col = binyanColor(c.binyan_group, false);
    const strokeW = 1.5 + (c.shared_verses / maxShared) * 4.2;
    const isSelected = state.verseWithEntryId === c.entry_id;
    const subLabel = `${c.shared_verses} פסוקים משותפים`;

    edges += `<line class="svg-edge co-edge" data-eid="${c.entry_id}" data-word="${escapeHtml(c.word)}"
      x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"
      stroke="${isSelected ? "var(--co-border)" : "var(--border-strong)"}"
      stroke-width="${isSelected ? 4.5 : strokeW.toFixed(1)}" stroke-opacity="${isSelected ? 1 : 0.7}" />`;

    const pw = Math.max(118, stripHebrewCons(c.word).length * 10.5 + 38, subLabel.length * 5.8 + 24);
    nodes += `
      <g class="svg-node co-node" data-eid="${c.entry_id}" data-word="${escapeHtml(c.word)}" transform="translate(${nx.toFixed(1)}, ${ny.toFixed(1)})">
        <rect x="${(-pw / 2).toFixed(1)}" y="-19" width="${pw.toFixed(1)}" height="38" rx="19"
          fill="${isSelected ? "var(--co-bg)" : "var(--bg-elevated)"}"
          stroke="${isSelected ? "var(--co-border)" : col}" stroke-width="${isSelected ? 2.5 : 1.7}" />
        <text x="0" y="-1" text-anchor="middle" direction="rtl" fill="var(--text)"
          font-family="Frank Ruhl Libre, serif" font-size="14.5" font-weight="700">${escapeHtml(c.word)}</text>
        <text x="0" y="13" text-anchor="middle" direction="rtl" fill="var(--text-muted)"
          font-family="Heebo, sans-serif" font-size="10">${subLabel}</text>
      </g>`;
  });

  nodes += `
    <g>
      <circle cx="${cx}" cy="${cy}" r="45" fill="var(--lapis-soft)" stroke="var(--lapis)" stroke-width="2.5" />
      <text x="${cx}" y="${cy + 6}" text-anchor="middle" direction="rtl" fill="var(--text)"
        font-family="Frank Ruhl Libre, serif" font-size="19" font-weight="900">${escapeHtml(centerTxt)}</text>
    </g>`;

  svg.innerHTML = `<g>${edges}</g><g>${nodes}</g>`;

  svg.querySelectorAll(".co-node, .co-edge").forEach((node) => {
    node.addEventListener("click", () => {
      const eid = Number(node.dataset.eid);
      if (state.verseWithEntryId === eid) {
        state.verseWithEntryId = null;
        state.verseWithLabel = "";
      } else {
        state.verseWithEntryId = eid;
        state.verseWithLabel = node.dataset.word;
      }
      renderCollocationsSvg(collocations);
      loadOccurrences(true);
    });
  });
}

function renderDistributionChart(bookDist) {
  const container = el("distributionChart");
  const countMap = new Map(bookDist.map((r) => [r.book_id, r.count]));
  const maxCount = Math.max(...bookDist.map((r) => r.count), 1);

  if (!bookDist.length) {
    container.innerHTML = `<div class="empty-state">אין נתוני התפלגות להצגה.</div>`;
    return;
  }

  const legend = `
    <div class="dist-legend">
      <span><i style="background:var(--div-torah)"></i> תורה</span>
      <span><i style="background:var(--div-neviim)"></i> נביאים</span>
      <span><i style="background:var(--div-ketuvim)"></i> כתובים</span>
    </div>`;

  const bars = db.books
    .filter((b) => countMap.has(b.book_id))
    .map((b) => {
      const cnt = countMap.get(b.book_id) || 0;
      const pct = Math.max(6, Math.round((cnt / maxCount) * 100));
      const isAct = state.verseFilterBookId === b.book_id ? " active" : "";
      const fillCol = DIV_COLORS[b.division] || "var(--lapis)";
      return `
        <button class="dist-bar-btn${isAct}" data-bookid="${b.book_id}">
          <div class="dist-bar-top">
            <span>${escapeHtml(b.name_he)}</span>
            <span>${fmtNum(cnt)}</span>
          </div>
          <div class="dist-track">
            <div class="dist-fill" style="width:${pct}%;background:${fillCol}"></div>
          </div>
        </button>`;
    })
    .join("");

  container.innerHTML = `${legend}<div class="dist-bars">${bars}</div>`;
  container.querySelectorAll(".dist-bar-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const bid = Number(btn.dataset.bookid);
      state.verseFilterBookId = state.verseFilterBookId === bid ? null : bid;
      renderDistributionChart(bookDist);
      loadOccurrences(true);
    });
  });
}

function loadOccurrences(reset) {
  if (!state.activeTarget) return;
  if (reset) {
    state.verseOffset = 0;
    state.versesData = [];
  }

  const data = localGetOccurrences({
    entryId: state.activeTarget.type === "entry" ? state.activeTarget.entryId : null,
    root: state.activeTarget.type === "root" ? state.activeTarget.root : null,
    withEntryId: state.verseWithEntryId,
    binyan: state.verseFilterBinyan,
    division: "all",
    bookId: state.verseFilterBookId,
    limit: 25,
    offset: state.verseOffset,
  });

  state.versesTotal = data.total_verses;
  state.versesOccTotal = data.total_occurrences;
  state.versesData = reset ? data.verses : state.versesData.concat(data.verses);
  state.verseOffset = state.versesData.length;
  state.versesHighlightEids = new Set(data.highlight_entry_ids || []);
  state.versesCoEids = new Set(data.co_entry_ids || []);
  state.versesMeta = { ...(reset ? {} : state.versesMeta), ...(data.entry_meta || {}) };

  renderActiveFiltersBar();
  renderVersesList();
}

function renderActiveFiltersBar() {
  const bar = el("activeFiltersBar");
  const chips = [];
  if (state.verseFilterBinyan !== "all") {
    const lbl = BINYAN_LABELS[state.verseFilterBinyan] || state.verseFilterBinyan;
    chips.push(`<button class="active-chip" data-clear="binyan">בניין: ${escapeHtml(lbl)} ✕</button>`);
  }
  if (state.verseFilterBookId) {
    const bk = db.bookById.get(state.verseFilterBookId);
    chips.push(`<button class="active-chip" data-clear="book">ספר: ${escapeHtml(bk?.name_he || "")} ✕</button>`);
  }
  if (state.verseWithEntryId) {
    chips.push(`<button class="active-chip" data-clear="with">מופיע עם: ${escapeHtml(state.verseWithLabel)} ✕</button>`);
  }

  if (!chips.length) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
  } else {
    bar.classList.remove("hidden");
    bar.innerHTML = chips.join("");
    bar.querySelectorAll(".active-chip").forEach((c) => {
      c.addEventListener("click", () => {
        if (c.dataset.clear === "binyan") state.verseFilterBinyan = "all";
        if (c.dataset.clear === "book") state.verseFilterBookId = null;
        if (c.dataset.clear === "with") {
          state.verseWithEntryId = null;
          state.verseWithLabel = "";
          if (state.vizTab === "collocations") {
            const cols = state.entryData?.collocations || state.rootData?.collocations || [];
            renderCollocationsSvg(cols);
          }
        }
        loadOccurrences(true);
      });
    });
  }
}

function renderVerseTokensHtml(tokens, highlightEids, coEids, highlightCons = null) {
  return tokens
    .map(([eid, wVoc, wCant, sep]) => {
      const text = state.showCantillation ? wCant : wVoc;
      let cls = "v-word";
      if (highlightEids && highlightEids.has(eid)) {
        cls += " hl-target";
      } else if (coEids && coEids.has(eid)) {
        cls += " hl-co";
      } else if (highlightCons && highlightCons.has(db.entries[eid].consonants)) {
        cls += " hl-target";
      }
      const sepClass = sep === "־" ? "v-sep maqqef" : "v-sep";
      return `<span class="${cls}" data-eid="${eid}">${escapeHtml(text)}</span><span class="${sepClass}">${escapeHtml(sep)}</span>`;
    })
    .join("");
}

function renderVersesList() {
  el("versesSummary").textContent =
    `מציג ${fmtNum(state.versesData.length)} מתוך ${fmtNum(state.versesTotal)} פסוקים (${fmtNum(state.versesOccTotal)} מופעים)`;

  const list = el("versesList");
  if (!state.versesData.length) {
    list.innerHTML = `<div class="empty-state">לא נמצאו פסוקים התואמים לסינון זה.</div>`;
  } else {
    list.innerHTML = state.versesData
      .map(
        (v) => `
      <div class="verse-card">
        <div class="verse-meta-row">
          <span class="verse-ref">${escapeHtml(v.ref_he)}</span>
          <button class="chapter-open-btn" data-book="${v.book_id}" data-chapter="${v.chapter}" data-verse="${v.verse}">פרק מלא ↗</button>
        </div>
        <div class="verse-text">${renderVerseTokensHtml(v.tokens, state.versesHighlightEids, state.versesCoEids)}</div>
      </div>`
      )
      .join("");
  }

  el("versesMoreWrap").classList.toggle("hidden", state.versesData.length >= state.versesTotal);
}

function runPhraseSearch(reset) {
  if (reset) {
    state.phraseOffset = 0;
    state.phraseVerses = [];
  }
  const q = state.q.trim();
  if (!q) {
    el("phraseEmptyHint").classList.remove("hidden");
    el("phraseVersesList").innerHTML = "";
    el("phraseMoreWrap").classList.add("hidden");
    el("phraseSummary").textContent = "";
    return;
  }
  el("phraseEmptyHint").classList.add("hidden");

  const data = localVersesSearch({
    q,
    division: state.division,
    bookId: state.bookId,
    limit: 30,
    offset: state.phraseOffset,
  });
  state.phraseTotal = data.total;
  state.phraseVerses = reset ? data.verses : state.phraseVerses.concat(data.verses);
  state.phraseOffset = state.phraseVerses.length;
  state.phraseMeta = { ...(reset ? {} : state.phraseMeta), ...(data.entry_meta || {}) };
  state.phraseHighlightCons = new Set(data.highlight_consonants || []);
  renderPhraseVerses();
}

function renderPhraseVerses() {
  el("phraseSummary").textContent =
    `מציג ${fmtNum(state.phraseVerses.length)} מתוך ${fmtNum(state.phraseTotal)} פסוקים תואמים`;
  const list = el("phraseVersesList");
  if (!state.phraseVerses.length) {
    list.innerHTML = `<div class="empty-state">לא נמצאו פסוקים הכוללים את הביטוי המבוקש.</div>`;
  } else {
    list.innerHTML = state.phraseVerses
      .map(
        (v) => `
      <div class="verse-card">
        <div class="verse-meta-row">
          <span class="verse-ref">${escapeHtml(v.ref_he)}</span>
          <button class="chapter-open-btn" data-book="${v.book_id}" data-chapter="${v.chapter}" data-verse="${v.verse}">פרק מלא ↗</button>
        </div>
        <div class="verse-text">${renderVerseTokensHtml(v.tokens, null, null, state.phraseHighlightCons)}</div>
      </div>`
      )
      .join("");
  }
  el("phraseMoreWrap").classList.toggle("hidden", state.phraseVerses.length >= state.phraseTotal);
}

function showTooltip(x, y, info) {
  const [word, root, binyan, occ] = info;
  const tt = el("wordTooltip");
  tt.innerHTML = `
    <div class="tt-word">${escapeHtml(word)}</div>
    <div class="tt-row">שורש: <strong>${root === "-" ? "—" : escapeHtml(root)}</strong></div>
    <div class="tt-row">בניין: <strong>${binyan === "-" ? "ללא בניין" : escapeHtml(binyan)}</strong></div>
    <div class="tt-row">מופעים בתנ"ך: <strong>${fmtNum(occ)}</strong></div>
  `;
  tt.classList.remove("hidden");
  const left = Math.min(window.innerWidth - 210, Math.max(12, x - 90));
  const top = Math.max(12, y - 108);
  tt.style.left = `${left}px`;
  tt.style.top = `${top}px`;
}

function hideTooltip() {
  el("wordTooltip").classList.add("hidden");
}

function loadChapter(bookId, chapter, focusVerse) {
  const data = localGetChapter(bookId, chapter);
  state.drawerBookId = bookId;
  state.drawerChapter = chapter;
  state.drawerFocusVerse = focusVerse;
  state.drawerMaxChapter = data.max_chapter;
  state.drawerMeta = data.entry_meta || {};

  el("drawerTitle").textContent = `${data.book.name_he}, פרק ${data.chapter_gematria}`;
  el("prevChapBtn").disabled = chapter <= 1;
  el("nextChapBtn").disabled = chapter >= data.max_chapter;

  const body = el("drawerBody");
  body.innerHTML = data.verses
    .map((v) => {
      const focusCls = focusVerse === v.verse ? " focus-verse" : "";
      return `
      <div class="drawer-verse${focusCls}" id="dv-${v.verse}">
        <span class="drawer-vnum">${escapeHtml(v.verse_gematria)}</span>
        <span class="verse-text">${renderVerseTokensHtml(v.tokens, state.versesHighlightEids, state.versesCoEids)}</span>
      </div>`;
    })
    .join("");

  el("drawerBackdrop").classList.remove("hidden");
  el("chapterDrawer").classList.remove("hidden");

  if (focusVerse) {
    const targetEl = el(`dv-${focusVerse}`);
    if (targetEl) targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    body.scrollTop = 0;
  }
}

function closeDrawer() {
  el("drawerBackdrop").classList.add("hidden");
  el("chapterDrawer").classList.add("hidden");
}

document.addEventListener("DOMContentLoaded", init);
