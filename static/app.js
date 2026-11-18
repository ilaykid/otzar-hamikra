/* אוצר המקרא — Interactive Tanakh Search, Relationship Graph & Verse Explorer */

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

const state = {
  overview: null,
  mode: "words", // 'words' | 'verses'
  q: "",
  binyan: "all",
  division: "all",
  bookId: null,
  sort: "freq",
  showCantillation: false,
  searchOffset: 0,
  searchItems: [],
  searchTotal: 0,

  activeTarget: null, // { type: 'entry', entryId } | { type: 'root', root }
  entryData: null,
  rootData: null,
  vizTab: "constellation", // 'constellation' | 'collocations' | 'distribution'
  zoom: 1,

  // Verse reader filters scoped to current detail view
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

  // Free verse search
  phraseOffset: 0,
  phraseVerses: [],
  phraseMeta: {},
  phraseHighlightCons: new Set(),
  phraseTotal: 0,

  // Chapter drawer
  drawerBookId: null,
  drawerChapter: null,
  drawerFocusVerse: null,
  drawerMaxChapter: 1,
};

const el = (id) => document.getElementById(id);

function fmtNum(n) {
  return Number(n || 0).toLocaleString("he-IL");
}

function stripHebrewCons(str) {
  return Array.from(str || "")
    .filter((ch) => ch >= "\u05D0" && ch <= "\u05EA")
    .join("");
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

async function apiGet(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ---------------- Initialization ----------------

async function init() {
  bindEvents();
  const overview = await apiGet("/api/overview");
  state.overview = overview;
  const t = overview.totals;
  el("corpusStats").textContent =
    `${fmtNum(t.tokens)} מופעים · ${fmtNum(t.entries)} צורות מנוקדות · ${fmtNum(t.roots)} שורשים · ${fmtNum(t.verses)} פסוקים`;

  populateBookSelect(overview.books);
  await runSearch(true);

  const defRoot = overview.spotlights?.default_root || "ה.ל.כ";
  await selectRoot(defRoot);
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

// ---------------- Event Wiring ----------------

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
    }, 180);
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

  // Delegate interactive clicks inside verse lists & chapter drawer
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

async function handleSpotlight(code) {
  if (state.mode !== "words") switchMode("words");
  const sp = state.overview?.spotlights || {};
  if (code.startsWith("root:")) {
    const r = code.slice(5);
    state.q = r;
    el("searchInput").value = r;
    el("clearSearchBtn").classList.remove("hidden");
    await runSearch(true);
    await selectRoot(r);
  } else if (code === "entry:banu" && sp.banu_entry_id) {
    state.q = "בנו";
    el("searchInput").value = "בנו";
    el("clearSearchBtn").classList.remove("hidden");
    await runSearch(true);
    await selectEntry(sp.banu_entry_id);
  } else if (code === "entry:kol" && sp.kol_qamats_id) {
    state.q = "כל";
    el("searchInput").value = "כל";
    el("clearSearchBtn").classList.remove("hidden");
    await runSearch(true);
    await selectEntry(sp.kol_qamats_id);
  } else if (code === "rare") {
    state.q = "";
    el("searchInput").value = "";
    el("clearSearchBtn").classList.add("hidden");
    state.sort = "rare";
    el("sortFilter").value = "rare";
    await runSearch(true);
    if (state.searchItems.length > 0) {
      await selectEntry(state.searchItems[0].entry_id);
    }
  }
}

// ---------------- Search & Master List ----------------

async function runSearch(reset) {
  if (reset) {
    state.searchOffset = 0;
    state.searchItems = [];
  }
  const params = new URLSearchParams({
    q: state.q,
    binyan: state.binyan,
    division: state.division,
    sort: state.sort,
    limit: "70",
    offset: String(state.searchOffset),
  });
  if (state.bookId) params.set("book_id", String(state.bookId));

  const data = await apiGet(`/api/search?${params.toString()}`);
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
  box.innerHTML = `<div class="strip-label">שורשים תואמים — לחץ למפת משפחת השורש:</div>` +
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

// ---------------- Detail Selection (Entry / Root) ----------------

async function selectEntry(entryId) {
  state.activeTarget = { type: "entry", entryId };
  state.verseFilterBinyan = "all";
  state.verseFilterBookId = null;
  state.verseWithEntryId = null;
  state.verseWithLabel = "";

  const data = await apiGet(`/api/entry/${entryId}`);
  state.entryData = data;
  state.rootData = null;

  renderResultsList();
  renderHeroForEntry(data);
  renderActiveViz(data.graph, data.collocations, data.book_distribution);
  await loadOccurrences(true);
}

async function selectRoot(rootStr) {
  state.activeTarget = { type: "root", root: rootStr };
  state.verseFilterBinyan = "all";
  state.verseFilterBookId = null;
  state.verseWithEntryId = null;
  state.verseWithLabel = "";

  const data = await apiGet(`/api/root/${encodeURIComponent(rootStr)}`);
  state.rootData = data;
  state.entryData = null;

  renderResultsList();
  renderHeroForRoot(data);
  renderActiveViz(data.graph, data.collocations, data.book_distribution);
  await loadOccurrences(true);
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

  // Homographs strip
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

  // Niqqud twins strip
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

// ---------------- Interactive SVG Graphs & Distribution ----------------

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

  // Iterative bounding-box collision relaxation so zero pills ever overlap or clip
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
      // Keep word pills away from inner binyan ring
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
      // Clamp cleanly inside SVG viewBox
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

  const centerTitle = graph.center_label;
  nodesHtml += `
    <g class="svg-node center-node">
      <circle cx="${cx}" cy="${cy}" r="45" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="3" />
      <circle cx="${cx}" cy="${cy}" r="39" fill="var(--bg-elevated)" stroke="var(--accent)" stroke-width="1.2" />
      <text x="${cx}" y="${cy + 6}" text-anchor="middle" direction="rtl" fill="var(--text)"
        font-family="Frank Ruhl Libre, serif" font-size="22" font-weight="900">${escapeHtml(centerTitle)}</text>
    </g>`;

  svg.innerHTML = `<g>${edgesHtml}</g><g>${nodesHtml}</g>`;

  svg.querySelectorAll(".word-node").forEach((n) => {
    n.addEventListener("click", () => selectEntry(Number(n.dataset.eid)));
  });
  svg.querySelectorAll(".binyan-node").forEach((n) => {
    n.addEventListener("click", () => {
      if (state.activeTarget?.type === "entry" && state.entryData?.entry?.root !== "-") {
        selectRoot(state.entryData.entry.root).then(() => {
          state.verseFilterBinyan = n.dataset.bgroup;
          loadOccurrences(true);
        });
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
  const books = state.overview?.books || [];
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

  const bars = books
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

// ---------------- Verses & Chapter Reader ----------------

async function loadOccurrences(reset) {
  if (!state.activeTarget) return;
  if (reset) {
    state.verseOffset = 0;
    state.versesData = [];
  }

  const params = new URLSearchParams({
    limit: "25",
    offset: String(state.verseOffset),
  });
  if (state.activeTarget.type === "entry") {
    params.set("entry_id", String(state.activeTarget.entryId));
  } else {
    params.set("root", state.activeTarget.root);
    if (state.verseFilterBinyan !== "all") {
      params.set("binyan", state.verseFilterBinyan);
    }
  }
  if (state.verseFilterBookId) params.set("book_id", String(state.verseFilterBookId));
  if (state.verseWithEntryId) params.set("with_entry_id", String(state.verseWithEntryId));

  const data = await apiGet(`/api/occurrences?${params.toString()}`);
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
    const bk = (state.overview?.books || []).find((b) => b.book_id === state.verseFilterBookId);
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
      } else if (highlightCons && highlightCons.has(stripHebrewCons(wVoc))) {
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

// ---------------- Free Phrase Verse Search ----------------

async function runPhraseSearch(reset) {
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

  const params = new URLSearchParams({
    q,
    division: state.division,
    limit: "30",
    offset: String(state.phraseOffset),
  });
  if (state.bookId) params.set("book_id", String(state.bookId));

  const data = await apiGet(`/api/verses/search?${params.toString()}`);
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

// ---------------- Tooltip & Chapter Drawer ----------------

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

async function loadChapter(bookId, chapter, focusVerse) {
  const data = await apiGet(`/api/chapter/${bookId}/${chapter}`);
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
