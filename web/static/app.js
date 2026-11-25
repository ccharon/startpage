'use strict';
/* Local bookmark start page, vanilla JS single page app.
 * Sections: pure helpers & search · import logic · state · API · render · tooltip · search (UI)
 *           · drag & drop · modals · import/export (UI) · theme · init
 */
(function () {

  // ===================================================================
  // Pure helpers, exported for the Node tests in web/test
  // ===================================================================

  function safeUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const u = new URL(raw);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) return u;
    } catch (e) { /* invalid */ }
    return null;
  }

  // User input -> normalized http(s) URL or null. Without a scheme, https:// is prepended.
  function normalizeUrlInput(input) {
    let s = String(input == null ? '' : input).trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) {
      // reject other schemes (javascript:, mailto:, file: …); "host:8080" is a port, not a scheme
      if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return null;
      s = 'https://' + s.replace(/^\/+/, '');
    }
    const u = safeUrl(s);
    return u ? u.href : null;
  }

  const DEFAULT_SEARCH_TEMPLATE = 'https://duckduckgo.com/?q=%s';
  const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

  // Heuristic like an address bar: "example.org", "http://x", "localhost:8080", "intranet/path", "10.0.0.1".
  function looksLikeUrl(q) {
    const s = String(q || '').trim();
    if (!s || /\s/.test(s)) return false;
    if (/^https?:\/\//i.test(s)) return !!safeUrl(s);
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return false;
    const m = /^([^\/?#:]+)(:\d{1,5})?([\/?#].*)?$/.exec(s);
    if (!m) return false;
    const host = m[1].toLowerCase();
    if (host === 'localhost' || IPV4_RE.test(host)) return true;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return true;
    return /^[a-z0-9-]+$/.test(host) && (!!m[2] || !!m[3]);
  }

  // Local/single-label hosts usually without TLS, public domains with https.
  function urlFromInput(q) {
    const s = String(q || '').trim();
    if (/^https?:\/\//i.test(s)) { const u = safeUrl(s); return u ? u.href : null; }
    const host = s.split(/[\/?#:]/)[0].toLowerCase();
    const plain = host === 'localhost' || IPV4_RE.test(host) || !host.includes('.');
    const u = safeUrl((plain ? 'http://' : 'https://') + s);
    return u ? u.href : null;
  }

  function isValidSearchTemplate(t) {
    return typeof t === 'string' && t.includes('%s') && !!safeUrl(t.split('%s').join('x'));
  }

  function searchUrl(template, q) {
    const t = isValidSearchTemplate(template) ? template : DEFAULT_SEARCH_TEMPLATE;
    return t.split('%s').join(encodeURIComponent(String(q || '').trim()));
  }

  // Target for Enter without results: {kind: 'url'|'search', url}
  function fallbackTarget(q, template) {
    if (looksLikeUrl(q)) { const url = urlFromInput(q); if (url) return { kind: 'url', url }; }
    return { kind: 'search', url: searchUrl(template, q) };
  }

  function urlKey(url) {
    const u = safeUrl(url);
    return u ? u.href.toLowerCase() : String(url).toLowerCase();
  }

  function parseTags(str) {
    const seen = new Set();
    const out = [];
    for (const raw of String(str || '').split(',')) {
      const t = raw.trim();
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    }
    return out;
  }

  function hashHue(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function isWordChar(ch) { return /[\p{L}\p{N}]/u.test(ch); }

  function initials(title) {
    const words = String(title || '').trim().split(/[\s\-_.\/:|]+/).filter(w => /[\p{L}\p{N}]/u.test(w));
    const firstAlnum = w => (w.match(/[\p{L}\p{N}]/u) || [''])[0];
    let r = '';
    if (words.length >= 2) r = firstAlnum(words[0]) + firstAlnum(words[1]);
    else if (words.length === 1) r = (words[0].match(/[\p{L}\p{N}]/gu) || []).slice(0, 2).join('');
    return (r || '?').toUpperCase();
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function byOrder(a, b) {
    const ao = Number.isFinite(a.order) ? a.order : 0;
    const bo = Number.isFinite(b.order) ? b.order : 0;
    return ao - bo;
  }

  // Defensive normalization (server data or cache); sorts arrays by order.
  function normalizeData(d) {
    const out = { version: 1, categories: [] };
    if (!d || typeof d !== 'object') return out;
    if (Number.isFinite(d.version)) out.version = d.version;
    const cats = Array.isArray(d.categories) ? d.categories.filter(c => c && typeof c === 'object') : [];
    for (const c of cats) {
      const bms = Array.isArray(c.bookmarks) ? c.bookmarks.filter(b => b && typeof b === 'object') : [];
      out.categories.push({
        id: String(c.id || uuid()),
        name: String(c.name || ''),
        order: Number.isFinite(c.order) ? c.order : 0,
        inline: c.inline === true,
        bookmarks: bms.map(b => {
          const o = {
            id: String(b.id || uuid()),
            title: String(b.title || ''),
            url: String(b.url || ''),
            tags: Array.isArray(b.tags) ? b.tags.filter(t => typeof t === 'string') : [],
            order: Number.isFinite(b.order) ? b.order : 0
          };
          if (typeof b.description === 'string' && b.description) o.description = b.description;
          // The server omits zero counters, so they are only kept when set.
          if (Number.isInteger(b.visits) && b.visits > 0) o.visits = b.visits;
          if (Number.isInteger(b.lastVisit) && b.lastVisit > 0) o.lastVisit = b.lastVisit;
          return o;
        }).sort(byOrder)
      });
    }
    out.categories.sort(byOrder);
    return out;
  }

  function renumber(data) {
    if (!Number.isFinite(data.version)) data.version = 1;
    data.categories.forEach((c, i) => {
      c.order = i;
      c.inline = i > 0 && c.inline === true;
      if (!Array.isArray(c.bookmarks)) c.bookmarks = [];
      c.bookmarks.forEach((b, j) => {
        b.order = j;
        if (!Array.isArray(b.tags)) b.tags = [];
      });
    });
    return data;
  }

  function moveBookmark(data, fromCatId, bmId, toCatId, refId, before) {
    const from = data.categories.find(c => c.id === fromCatId);
    const to = data.categories.find(c => c.id === toCatId);
    if (!from || !to) return false;
    const i = from.bookmarks.findIndex(b => b.id === bmId);
    if (i < 0) return false;
    const [bm] = from.bookmarks.splice(i, 1);
    const j = refId ? to.bookmarks.findIndex(b => b.id === refId) : -1;
    if (j < 0) to.bookmarks.push(bm);
    else to.bookmarks.splice(before ? j : j + 1, 0, bm);
    return true;
  }

  // Groups categories into rows: inline=true appends to the previous row.
  function categoryRows(cats) {
    const rows = [];
    for (const c of cats) {
      if (c.inline && rows.length) rows[rows.length - 1].push(c);
      else rows.push([c]);
    }
    return rows;
  }

  function flattenRows(data, rows) {
    data.categories = [];
    for (const row of rows) {
      row.forEach((c, k) => { c.inline = k > 0; data.categories.push(c); });
    }
  }

  // sameRow: place left/right of refId; otherwise as its own row above/below that row.
  function moveCategory(data, catId, refId, before, sameRow) {
    const rows = categoryRows(data.categories);
    let cat = null;
    for (let r = 0; r < rows.length && !cat; r++) {
      const k = rows[r].findIndex(c => c.id === catId);
      if (k >= 0) {
        cat = rows[r].splice(k, 1)[0];
        if (!rows[r].length) rows.splice(r, 1);
      }
    }
    if (!cat) return false;
    const r = rows.findIndex(row => row.some(c => c.id === refId));
    if (r < 0) rows.push([cat]);
    else if (sameRow) {
      const k = rows[r].findIndex(c => c.id === refId);
      rows[r].splice(before ? k : k + 1, 0, cat);
    } else rows.splice(before ? r : r + 1, 0, [cat]);
    flattenRows(data, rows);
    return true;
  }

  function removeCategory(data, catId) {
    const rows = categoryRows(data.categories);
    for (let r = 0; r < rows.length; r++) {
      const k = rows[r].findIndex(c => c.id === catId);
      if (k < 0) continue;
      rows[r].splice(k, 1);
      if (!rows[r].length) rows.splice(r, 1);
      flattenRows(data, rows);
      return true;
    }
    return false;
  }

  // ---------------------------- Search -------------------------------

  function buildIndex(data) {
    const items = [];
    for (const cat of data.categories) {
      for (const bm of cat.bookmarks) {
        const u = safeUrl(bm.url);
        items.push({
          bm, cat,
          t: bm.title.toLowerCase(),
          u: bm.url.toLowerCase(),
          h: u ? u.hostname.toLowerCase().replace(/^www\./, '') : '',
          g: bm.tags.map(x => x.toLowerCase()),
          d: (bm.description || '').toLowerCase()
        });
      }
    }
    return items;
  }

  function splitTerms(q) {
    return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  // Fuzzy subsequence search. Returns {score: 1..99, pos: [...]} or null.
  function fuzzyMatch(term, text) {
    const n = term.length;
    if (!n || !text) return null;
    let best = null;
    let starts = 0;
    for (let s = text.indexOf(term[0]); s !== -1 && starts < 30; s = text.indexOf(term[0], s + 1), starts++) {
      const pos = [s];
      let ti = 1;
      for (let i = s + 1; ti < n && i < text.length; i++) {
        if (text[i] === term[ti]) { pos.push(i); ti++; }
      }
      if (ti < n) break; // later start points cannot match either
      const span = pos[n - 1] - s + 1;
      if (span > n * 3 + 4) continue; // too scattered -> noise
      let bonus = 0;
      for (let k = 0; k < n; k++) {
        const p = pos[k];
        if (k > 0 && pos[k - 1] === p - 1) bonus += 4;
        if (p === 0 || !isWordChar(text[p - 1])) bonus += 3;
      }
      const score = Math.max(1, Math.min(99, 40 + bonus - (span - n) * 3));
      if (!best || score > best.score) best = { score, pos };
    }
    return best;
  }

  function isBoundary(text, i) { return i === 0 || !isWordChar(text[i - 1]); }

  // Score per search term: substring matches (>= 500) always rank above fuzzy ones (< 300).
  function termScore(term, it) {
    let best = -1;
    const i = it.t.indexOf(term);
    if (i >= 0) {
      let s = 900 - Math.min(i, 100);
      if (i === 0) s += 90; else if (isBoundary(it.t, i)) s += 50;
      if (it.t.length === term.length) s += 10;
      best = s;
    }
    for (const g of it.g) {
      if (g === term) best = Math.max(best, 850);
      else if (g.startsWith(term)) best = Math.max(best, 750);
      else if (g.includes(term)) best = Math.max(best, 650);
    }
    if (best < 600) {
      const hi = it.h.indexOf(term);
      if (hi >= 0) best = Math.max(best, isBoundary(it.h, hi) ? 600 : 550);
      else if (it.u.includes(term)) best = Math.max(best, 500);
    }
    // Below STRONG_MATCH: a description match alone never opens a bookmark directly.
    if (best < 450 && it.d) {
      const di = it.d.indexOf(term);
      if (di >= 0) best = Math.max(best, isBoundary(it.d, di) ? 450 : 400);
    }
    if (best < 0) {
      let f = fuzzyMatch(term, it.t);
      if (f) best = Math.max(best, 200 + f.score);
      for (const g of it.g) {
        f = fuzzyMatch(term, g);
        if (f) best = Math.max(best, 150 + f.score);
      }
      f = fuzzyMatch(term, it.h);
      if (f) best = Math.max(best, 100 + f.score);
    }
    return best;
  }

  // Term scores of at least this value come from substring, tag or host matches.
  const STRONG_MATCH = 500;

  // Capped below the gap between substring and fuzzy scores, so usage only
  // reorders matches of similar quality.
  function usageBonus(bm, nowSec) {
    if (!bm.visits) return 0;
    const days = (nowSec - (bm.lastVisit || 0)) / 86400;
    const recency = days < 4 ? 1 : days < 14 ? 0.7 : days < 31 ? 0.5 : days < 90 ? 0.3 : 0.1;
    return Math.min(80, Math.round(Math.log2(1 + bm.visits) * 20 * recency));
  }

  // All terms must match; results sorted by descending score.
  function search(index, query) {
    const terms = splitTerms(query);
    if (!terms.length) return [];
    const nowSec = Date.now() / 1000;
    const out = [];
    for (const it of index) {
      let total = 0;
      let minTerm = Infinity;
      let ok = true;
      for (const term of terms) {
        const s = termScore(term, it);
        if (s < 0) { ok = false; break; }
        total += s;
        minTerm = Math.min(minTerm, s);
      }
      if (ok) out.push({ item: it, score: total + usageBonus(it.bm, nowSec), minTerm });
    }
    out.sort((a, b) => (b.score - a.score) ||
      (a.item.t.length - b.item.t.length) ||
      a.item.t.localeCompare(b.item.t));
    return out;
  }

  // Boolean mask of the title characters to highlight.
  function highlightMask(text, terms) {
    const lower = text.toLowerCase();
    const mask = new Array(text.length).fill(false);
    if (lower.length !== text.length) return mask;
    for (const term of terms) {
      const i = lower.indexOf(term);
      if (i >= 0) {
        for (let k = i; k < i + term.length; k++) mask[k] = true;
      } else {
        const f = fuzzyMatch(term, lower);
        if (f) for (const p of f.pos) mask[p] = true;
      }
    }
    return mask;
  }

  // Tooltip position next to the pointer, flipped and clamped to stay inside the viewport.
  function tipPosition(x, y, w, h, vw, vh) {
    const gap = 16;
    let left = x + 12;
    let top = y + gap;
    if (left + w > vw - 4) left = vw - 4 - w;
    if (top + h > vh - 4) top = y - gap - h;
    return { left: Math.max(4, left), top: Math.max(4, top) };
  }

  // ------------------------- Import logic ----------------------------

  const MAX_TITLE = 500;
  const MAX_DESC = 2000;

  function cleanTitle(title, url) {
    let t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t) { const u = safeUrl(url); t = u ? u.hostname : url; }
    return t.slice(0, MAX_TITLE);
  }

  // Keeps line breaks, collapses other whitespace and blank line runs.
  function cleanDescription(text) {
    return String(text || '').replace(/\r\n?/g, '\n').split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim()).join('\n')
      .replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_DESC);
  }

  // Own JSON format -> {categories:[{name, bookmarks:[{title,url,tags}]}], skipped}
  function parseOwnJson(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.categories)) {
      throw new Error('Unknown JSON format: field "categories" (array) is missing.');
    }
    let skipped = 0;
    const cats = [];
    const srcCats = obj.categories.slice().filter(c => c && typeof c === 'object').sort(byOrder);
    skipped += obj.categories.length - srcCats.length;
    for (const c of srcCats) {
      if (typeof c.name !== 'string' || !c.name.trim()) { skipped++; continue; }
      if (c.bookmarks !== undefined && !Array.isArray(c.bookmarks)) { skipped++; continue; }
      const cat = { name: c.name.trim(), inline: c.inline === true, bookmarks: [] };
      const bms = (c.bookmarks || []).filter(b => b && typeof b === 'object').sort(byOrder);
      skipped += (c.bookmarks || []).length - bms.length;
      for (const b of bms) {
        const url = typeof b.url === 'string' ? (safeUrl(b.url.trim()) || {}).href : null;
        if (!url) { skipped++; continue; }
        const tags = Array.isArray(b.tags) ? parseTags(b.tags.filter(t => typeof t === 'string').join(',')) : [];
        const description = cleanDescription(typeof b.description === 'string' ? b.description : '');
        cat.bookmarks.push({ title: cleanTitle(typeof b.title === 'string' ? b.title : '', url), url, tags, description });
      }
      cats.push(cat);
    }
    return { categories: cats, skipped };
  }

  // Merges imported data into draft (mode 'merge') or replaces it (mode 'replace').
  function applyImport(draft, imported, mode) {
    const stats = { added: 0, duplicates: 0, newCategories: 0 };
    if (mode === 'replace') draft.categories = [];
    for (const ic of imported.categories) {
      const name = ic.name.trim();
      let cat = draft.categories.find(c => c.name.trim().toLowerCase() === name.toLowerCase());
      if (!cat) {
        cat = { id: uuid(), name, order: draft.categories.length, inline: mode === 'replace' && ic.inline === true, bookmarks: [] };
        draft.categories.push(cat);
        stats.newCategories++;
      }
      const seen = new Set(cat.bookmarks.map(b => urlKey(b.url)));
      for (const b of ic.bookmarks) {
        const key = urlKey(b.url);
        if (seen.has(key)) { stats.duplicates++; continue; }
        seen.add(key);
        const nb = { id: uuid(), title: b.title, url: b.url, tags: (b.tags || []).slice(), order: cat.bookmarks.length };
        if (b.description) nb.description = b.description;
        cat.bookmarks.push(nb);
        stats.added++;
      }
    }
    renumber(draft);
    return stats;
  }

  function folderHeading(dl) {
    let p = dl.previousElementSibling;
    while (p && p.tagName === 'P') p = p.previousElementSibling;
    if (p && p.tagName === 'H3') return p;
    let parent = dl.parentElement;
    // A folder description puts the folder's <DL> inside the <DD> after its <DT>.
    if (parent && parent.tagName === 'DD') parent = parent.previousElementSibling;
    if (parent && parent.tagName === 'DT') {
      for (const ch of parent.children) if (ch.tagName === 'H3') return ch;
    }
    return null;
  }

  // Netscape files put a description in the <DD> following the bookmark's <DT>.
  function netscapeDescription(a) {
    const dt = a.parentElement;
    const dd = dt && dt.tagName === 'DT' ? dt.nextElementSibling : null;
    if (!dd || dd.tagName !== 'DD') return '';
    let text = '';
    for (const n of dd.childNodes) if (n.nodeType === 3 || (n.nodeType === 1 && n.tagName !== 'DL')) text += n.textContent;
    return cleanDescription(text);
  }

  // Netscape-Bookmark-HTML (Edge/Chrome/Firefox) -> {categories, skipped}
  function parseNetscape(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const map = new Map();
    let skipped = 0;
    for (const a of doc.querySelectorAll('a[href]')) {
      const u = safeUrl((a.getAttribute('href') || '').trim());
      if (!u) { skipped++; continue; }
      const heads = [];
      for (let n = a.parentElement; n; n = n.parentElement) {
        if (n.tagName === 'DL') { const h = folderHeading(n); if (h) heads.unshift(h); }
      }
      // skip the favorites/bookmarks bar as root if it has subfolders
      if (heads.length > 1 && heads[0].hasAttribute('personal_toolbar_folder')) heads.shift();
      const names = heads.map(h => h.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const name = names.length ? names.join(' / ') : 'Imported';
      if (!map.has(name.toLowerCase())) map.set(name.toLowerCase(), { name, bookmarks: [] });
      const tags = parseTags(a.getAttribute('tags') || '');
      map.get(name.toLowerCase()).bookmarks.push({ title: cleanTitle(a.textContent, u.href), url: u.href, tags, description: netscapeDescription(a) });
    }
    return { categories: Array.from(map.values()).filter(c => c.bookmarks.length), skipped };
  }

  const pure = {
    safeUrl, normalizeUrlInput, parseTags, hashHue, initials, uuid, normalizeData, renumber,
    moveBookmark, moveCategory, categoryRows, removeCategory, buildIndex, splitTerms, fuzzyMatch, termScore, search,
    highlightMask, parseOwnJson, parseNetscape, applyImport, urlKey, looksLikeUrl, urlFromInput,
    fallbackTarget, isValidSearchTemplate, searchUrl, usageBonus, STRONG_MATCH, cleanTitle, cleanDescription, tipPosition
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof document === 'undefined') return;

  // ===================================================================
  // State
  // ===================================================================

  const LS_CACHE = 'startpage.cache.v1';
  const LS_THEME = 'startpage.theme';
  const LS_COLLAPSED = 'startpage.collapsed';
  const LS_VIEW = 'startpage.view';
  const LS_FONT = 'startpage.fontsize';
  const LS_SEARCH = 'startpage.searchTemplate';

  function searchTemplate() {
    const t = lsGet(LS_SEARCH);
    return isValidSearchTemplate(t) ? t : DEFAULT_SEARCH_TEMPLATE;
  }
  const MAX_RESULTS = 150;
  const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

  const state = {
    data: { version: 1, categories: [] },
    serverData: null,
    etag: null,
    loaded: false,
    readOnly: false,
    hasCache: false,
    loadError: '',
    lastUndo: null,
    editMode: false,
    view: 'tiles',
    index: [],
    query: '',
    results: [],
    sel: 0,
    gen: 0,
    pending: 0
  };
  let saveChain = Promise.resolve();
  const failedIcons = new Set();
  let collapsed = new Set();

  const $ = id => document.getElementById(id);

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === false || v === null || v === undefined) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* Quota/Policy */ } }

  function readCache() {
    try {
      const c = JSON.parse(lsGet(LS_CACHE) || 'null');
      if (c && c.data && Array.isArray(c.data.categories)) return c;
    } catch (e) { /* corrupt */ }
    return null;
  }
  function writeCache(data, etag) {
    lsSet(LS_CACHE, JSON.stringify({ data, etag, savedAt: new Date().toISOString() }));
  }

  function loadCollapsed() {
    try { collapsed = new Set(JSON.parse(lsGet(LS_COLLAPSED) || '[]')); } catch (e) { collapsed = new Set(); }
  }
  function saveCollapsed() { lsSet(LS_COLLAPSED, JSON.stringify(Array.from(collapsed))); }

  function canWrite() { return state.loaded && !state.readOnly; }
  function canDnd() { return canWrite() && !state.query; }
  function findCat(data, id) { return data.categories.find(c => c.id === id) || null; }
  function findBm(cat, id) { return cat ? cat.bookmarks.find(b => b.id === id) || null : null; }

  function reindex() {
    state.index = buildIndex(state.data);
    if (state.query) {
      state.results = search(state.index, state.query);
      state.sel = Math.max(0, Math.min(state.sel, state.results.length - 1));
    }
  }

  // ===================================================================
  // API
  // ===================================================================

  async function apiLoad() {
    const res = await fetch('/api/bookmarks', { headers: { 'Accept': 'application/json' }, cache: 'no-store' });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try {
        const j = await res.json();
        if (j && typeof j.error === 'string' && j.error) msg = j.error;
      } catch (e) { /* not JSON */ }
      const err = new Error(msg);
      err.fromServer = true;
      throw err;
    }
    const data = await res.json();
    return { data, etag: res.headers.get('ETag') };
  }

  function setServerData(data, etag) {
    const norm = normalizeData(data);
    state.serverData = norm;
    state.data = clone(norm);
    state.etag = etag || null;
    writeCache(norm, state.etag);
  }

  async function load() {
    const before = JSON.stringify(state.data) + '|' + state.readOnly;
    let ok = true;
    try {
      const r = await apiLoad();
      setServerData(r.data, r.etag);
      state.readOnly = false;
      state.loadError = '';
    } catch (e) {
      ok = false;
      state.loadError = e && e.fromServer ? e.message : '';
      const c = readCache();
      state.hasCache = !!c;
      if (c) { state.data = normalizeData(c.data); state.etag = c.etag || null; state.serverData = clone(state.data); }
      state.readOnly = true;
    }
    const first = !state.loaded;
    state.loaded = true;
    if (first || before !== JSON.stringify(state.data) + '|' + state.readOnly) {
      reindex();
      render();
    } else {
      updateChrome();
    }
    return ok;
  }

  // Applies mutate() to a copy, renders optimistically and saves serially.
  // opts: {undo: false} for changes that cannot be undone, {quiet: true} to skip the read-only notice.
  function commit(mutate, okMsg, opts) {
    opts = opts || {};
    if (!canWrite()) {
      if (!opts.quiet) toast('Read-only. Changes are currently not possible.', 'error');
      return;
    }
    const before = state.data;
    const draft = clone(state.data);
    if (mutate(draft) === false) return;
    renumber(draft);
    if (JSON.stringify(draft) === JSON.stringify(state.data)) return;
    const undoable = opts.undo !== false;
    if (undoable) state.lastUndo = { before, after: contentKey(draft) };
    state.data = draft;
    reindex();
    render();
    const gen = state.gen;
    state.pending++;
    updateStatus();
    saveChain = saveChain.then(() => doSave(draft, gen, okMsg, undoable));
  }

  function stripUsage(data) {
    return data.categories.map(c => Object.assign({}, c, {
      bookmarks: c.bookmarks.map(b => Object.assign({}, b, { visits: 0, lastVisit: 0 }))
    }));
  }

  // Usage counters are ignored, so opening a link does not block an undo.
  function contentKey(data) { return JSON.stringify(stripUsage(data)); }

  function undo() {
    const u = state.lastUndo;
    if (!u) { toast('Nothing to undo.'); return; }
    state.lastUndo = null;
    if (contentKey(state.data) !== u.after) { toast('Cannot undo: the data has changed since.', 'warn'); return; }
    commit(draft => {
      const usage = new Map();
      for (const c of draft.categories) for (const b of c.bookmarks) usage.set(b.id, b);
      draft.categories = clone(u.before.categories);
      for (const c of draft.categories) {
        for (const b of c.bookmarks) {
          const cur = usage.get(b.id);
          delete b.visits; delete b.lastVisit;
          if (cur && cur.visits) { b.visits = cur.visits; b.lastVisit = cur.lastVisit; }
        }
      }
      return true;
    }, 'Change undone', { undo: false });
  }

  // Returns the pending save, so callers can wait for it before leaving the page.
  function recordVisit(bmId) {
    commit(draft => {
      for (const c of draft.categories) {
        const b = c.bookmarks.find(x => x.id === bmId);
        if (b) { b.visits = (b.visits || 0) + 1; b.lastVisit = Math.floor(Date.now() / 1000); return true; }
      }
      return false;
    }, null, { undo: false, quiet: true });
    return saveChain;
  }

  // Deferred, so re-rendering does not remove the link before the browser follows it.
  function visitFromEvent(e) {
    const link = e.target.closest('a.tile-link, a.row-link');
    if (!link || !link.hasAttribute('href')) return;
    const item = link.closest('[data-bm-id]');
    if (item) setTimeout(() => recordVisit(item.dataset.bmId), 0);
  }

  function revert() {
    state.data = clone(state.serverData || { version: 1, categories: [] });
    reindex();
    render();
  }

  async function doSave(draft, gen, okMsg, undoable) {
    try {
      if (gen !== state.gen) return; // discarded after an error
      if (!state.etag) {
        state.gen++;
        toast('The data version is unknown. Reloading.', 'warn');
        await load();
        return;
      }
      let res;
      try {
        res = await fetch('/api/bookmarks', {
          method: 'PUT',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'If-Match': state.etag,
            'X-Requested-With': 'startpage'
          },
          body: JSON.stringify(draft)
        });
      } catch (e) {
        state.gen++;
        toast('Saving failed: server not reachable. Change discarded.', 'error');
        await load();
        return;
      }
      if (res.ok) {
        let stored = draft;
        try { stored = await res.json(); } catch (e) { /* empty body */ }
        const norm = normalizeData(stored);
        state.serverData = norm;
        state.etag = res.headers.get('ETag') || state.etag;
        writeCache(norm, state.etag);
        if (state.pending === 1 && gen === state.gen && JSON.stringify(norm) !== JSON.stringify(state.data)) {
          state.data = clone(norm);
          reindex();
          render();
        }
        if (okMsg) toast(typeof okMsg === 'function' ? okMsg() : okMsg, 'info', undoable ? { label: 'Undo', run: undo } : null);
        return;
      }
      state.gen++;
      if (res.status === 412) {
        toast('Data was changed in another tab or window. Reloading.', 'warn');
        await load();
        return;
      }
      let msg = 'Saving failed (HTTP ' + res.status + ')';
      try {
        const j = await res.json();
        if (j && typeof j.error === 'string' && j.error) msg = 'Saving failed: ' + j.error;
      } catch (e) { /* not JSON */ }
      toast(msg, 'error');
      revert();
    } finally {
      state.pending--;
      updateStatus();
    }
  }

  // ===================================================================
  // Render
  // ===================================================================

  function render() {
    hideTip();
    updateChrome();
    renderCategories();
    renderSearchView();
  }

  function updateChrome() {
    const body = document.body;
    body.classList.toggle('readonly', state.readOnly);
    body.classList.toggle('edit-mode', state.editMode && !state.readOnly);
    $('btn-edit').setAttribute('aria-pressed', String(state.editMode));
    $('btn-view-tiles').setAttribute('aria-pressed', String(state.view === 'tiles'));
    $('btn-view-details').setAttribute('aria-pressed', String(state.view === 'details'));
    const banner = $('banner');
    banner.hidden = !state.readOnly;
    const cause = state.loadError ? 'Server error: ' + state.loadError + '.' : 'Server not reachable.';
    $('banner-text').textContent = cause + (state.hasCache || state.data.categories.length
      ? ' Read-only view from cache.'
      : ' No cached data available.');
    updateStatus();
  }

  function updateStatus() {
    const nCat = state.data.categories.length;
    const nBm = state.index.length;
    $('status-count').textContent = nBm + (nBm === 1 ? ' bookmark · ' : ' bookmarks · ') + nCat + (nCat === 1 ? ' category' : ' categories');
    let mode = 'Ready';
    if (state.readOnly) mode = 'Read-only (cache)';
    else if (state.query) mode = state.results.length + (state.results.length === 1 ? ' match' : ' matches') + '. Enter opens, ↑/↓ selects, F2 edits, Esc clears.';
    else if (state.editMode) mode = 'Edit mode: click an entry to edit it, drag to reorder';
    $('status-mode').textContent = mode;
    $('status-save').textContent = state.pending > 0 ? 'Saving …' : (state.readOnly ? 'Offline' : 'Saved');
  }

  function favicon(title, u) {
    if (u && !failedIcons.has(u.origin)) {
      const img = el('img', {
        class: 'favicon', alt: '', width: 16, height: 16, loading: 'lazy', decoding: 'async',
        referrerpolicy: 'no-referrer', draggable: 'false'
      });
      img.referrerPolicy = 'no-referrer';
      const fail = () => { failedIcons.add(u.origin); img.replaceWith(fallbackIcon(title, u)); };
      img.addEventListener('error', fail, { once: true });
      img.addEventListener('load', () => { if (!img.naturalWidth) fail(); }, { once: true });
      img.src = u.origin + '/favicon.ico';
      return img;
    }
    return fallbackIcon(title, u);
  }

  function fallbackIcon(title, u) {
    const span = el('span', { class: 'favicon favicon-fallback', 'aria-hidden': 'true' }, initials(title));
    span.style.setProperty('--fb-hue', String(hashHue(u ? u.hostname.replace(/^www\./, '') : title)));
    return span;
  }

  function renderCategories() {
    const root = $('categories');
    const frag = document.createDocumentFragment();
    const cats = state.data.categories;
    if (!cats.length) {
      const box = el('section', { class: 'panel empty-panel' },
        titleBar('Welcome', null),
        el('div', { class: 'panel-body empty-body' },
          el('p', null, state.readOnly ? 'No data available.' : 'No bookmarks yet.'),
          state.readOnly ? null : el('p', { class: 'btn-row' },
            el('button', { type: 'button', class: 'btn', 'data-action': 'empty-add-cat' }, 'Create category'),
            el('button', { type: 'button', class: 'btn', 'data-action': 'empty-import' }, 'Import bookmarks'))));
      frag.append(box);
    }
    for (const row of categoryRows(cats)) {
      const line = el('div', { class: 'cat-row' + (row.length > 1 ? ' multi' : '') });
      for (const cat of row) line.append(renderCategory(cat));
      frag.append(line);
    }
    root.replaceChildren(frag);
  }

  function titleBar(text, cat) {
    const titleId = cat ? 'cat-title-' + cat.id : null;
    const bar = el('div', { class: 'titlebar' });
    bar.append(el('span', { class: 'wm-btn win-menu', 'aria-hidden': 'true' }));
    const h = el('h2', { class: 'title-text', id: titleId }, text);
    if (cat) h.append(el('span', { class: 'title-count' }, ' (' + cat.bookmarks.length + ')'));
    bar.append(h);
    if (cat) {
      if (!state.readOnly) bar.setAttribute('draggable', 'true');
      bar.append(el('span', { class: 'title-actions edit-only' },
        el('button', { type: 'button', class: 'tb-btn', 'data-action': 'add-bm', title: 'Add bookmark', 'aria-label': 'Add bookmark' }, '+'),
        el('button', { type: 'button', class: 'tb-btn', 'data-action': 'edit-cat', title: 'Edit category', 'aria-label': 'Edit category' }, '✎'),
        el('button', { type: 'button', class: 'tb-btn', 'data-action': 'del-cat', title: 'Delete category', 'aria-label': 'Delete category' }, '✕')));
      const isCol = collapsed.has(cat.id);
      bar.append(el('button', {
        type: 'button', class: 'wm-btn win-min', 'data-action': 'toggle-collapse',
        'aria-expanded': String(!isCol), title: isCol ? 'Expand' : 'Collapse',
        'aria-label': (isCol ? 'Expand: ' : 'Collapse: ') + cat.name
      }));
    } else {
      bar.append(el('span', { class: 'wm-btn win-min', 'aria-hidden': 'true' }));
    }
    bar.append(el('span', { class: 'wm-btn win-max', 'aria-hidden': 'true' }));
    return bar;
  }

  function renderCategory(cat) {
    const isCol = collapsed.has(cat.id);
    const panel = el('section', {
      class: 'panel' + (isCol ? ' collapsed' : ''), 'data-cat-id': cat.id, 'aria-labelledby': 'cat-title-' + cat.id
    });
    panel.append(titleBar(cat.name, cat));
    const details = state.view === 'details';
    const body = el('div', { class: 'panel-body' + (details ? ' details' : ''), hidden: isCol });
    if (cat.bookmarks.length && details) {
      const list = el('div', { class: 'row-list', role: 'list' });
      for (const bm of cat.bookmarks) list.append(renderDetailRow(cat, bm, { actions: true }));
      body.append(list);
    } else if (cat.bookmarks.length) {
      const grid = el('div', { class: 'tile-grid' });
      for (const bm of cat.bookmarks) grid.append(renderTile(cat, bm));
      body.append(grid);
    } else {
      body.append(el('p', { class: 'empty-hint' },
        state.readOnly ? 'No bookmarks.' : 'No bookmarks. Drag them here or click “+” in edit mode.'));
    }
    panel.append(body);
    return panel;
  }

  // Link to a bookmark; href only for http/https. Details appear in the custom tooltip.
  function bookmarkLink(cls, u, bm) {
    const a = el('a', { class: cls, draggable: 'false', 'aria-description': bm.description || null });
    if (u) {
      a.href = u.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.referrerPolicy = 'no-referrer';
    } else {
      a.classList.add('invalid');
      a.setAttribute('aria-disabled', 'true');
      a.tabIndex = 0;
    }
    return a;
  }

  // Returned as a list so that Element.append can take it spread.
  function descMark(bm) {
    return bm.description ? [el('span', { class: 'desc-mark', 'aria-hidden': 'true' })] : [];
  }

  function itemActions(bm) {
    return el('span', { class: 'item-actions edit-only' },
      el('button', { type: 'button', class: 'tb-btn', 'data-action': 'edit-bm', title: 'Edit', 'aria-label': 'Edit: ' + bm.title }, '✎'),
      el('button', { type: 'button', class: 'tb-btn', 'data-action': 'del-bm', title: 'Delete', 'aria-label': 'Delete: ' + bm.title }, '✕'));
  }

  function renderTile(cat, bm) {
    const u = safeUrl(bm.url);
    const tile = el('div', {
      class: 'item tile', 'data-bm-id': bm.id, 'data-cat-id': cat.id, draggable: state.readOnly ? false : 'true'
    });
    const a = bookmarkLink('tile-link', u, bm);
    a.append(favicon(bm.title, u), el('span', { class: 'tile-title' }, bm.title), ...descMark(bm));
    tile.append(a);
    if (!state.readOnly) tile.append(itemActions(bm));
    return tile;
  }

  // Detail row, shared by search results and the details view of the categories.
  // opts: {terms, showCat, actions, editable}
  function renderDetailRow(cat, bm, opts) {
    const u = safeUrl(bm.url);
    const inCategory = !!opts.actions;
    const row = el('div', {
      class: 'row' + (inCategory ? ' item' : ''), 'data-bm-id': bm.id, 'data-cat-id': cat.id,
      role: inCategory ? 'listitem' : null,
      draggable: inCategory && !state.readOnly ? 'true' : false
    });
    const a = bookmarkLink('row-link' + (opts.showCat ? ' with-cat' : ''), u, bm);
    const titleCell = el('span', { class: 'r-title' }, opts.terms ? highlighted(bm.title, opts.terms) : bm.title);
    for (const t of bm.tags) titleCell.append(el('span', { class: 'tag' }, t));
    a.append(
      el('span', { class: 'r-icon' }, favicon(bm.title, u)),
      titleCell,
      el('span', { class: 'r-url mono' }, bm.url),
      ...descMark(bm));
    if (opts.showCat) a.append(el('span', { class: 'r-cat' }, cat.name));
    row.append(a);
    if ((inCategory || opts.editable) && !state.readOnly) row.append(itemActions(bm));
    return row;
  }

  function highlighted(text, terms) {
    const mask = highlightMask(text, terms);
    const frag = document.createDocumentFragment();
    let i = 0;
    while (i < text.length) {
      const m = mask[i];
      let j = i;
      while (j < text.length && mask[j] === m) j++;
      const s = text.slice(i, j);
      frag.append(m ? el('mark', null, s) : document.createTextNode(s));
      i = j;
    }
    return frag;
  }

  function renderSearchView() {
    const searching = !!state.query;
    const list = $('results');
    const input = $('search');
    $('categories').hidden = searching;
    list.hidden = !searching;
    input.setAttribute('aria-expanded', String(searching));
    if (!searching) {
      list.replaceChildren();
      input.removeAttribute('aria-activedescendant');
      updateStatus();
      return;
    }
    const terms = splitTerms(state.query);
    const frag = document.createDocumentFragment();
    if (!state.results.length) {
      const target = fallbackTarget(state.query, searchTemplate());
      const what = target.kind === 'url'
        ? 'Enter opens ' + target.url
        : 'Enter searches with ' + safeUrl(target.url).hostname.replace(/^www\./, '');
      frag.append(el('div', { class: 'no-results' }, 'No matches for “' + state.query.trim() + '”. ' + what + '.'));
    }
    const shown = state.results.slice(0, MAX_RESULTS);
    shown.forEach((r, i) => {
      const row = renderDetailRow(r.item.cat, r.item.bm, { terms, showCat: true, editable: true });
      row.classList.add('result');
      if (i === state.sel) row.classList.add('selected');
      row.id = 'res-' + i;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === state.sel));
      row.dataset.index = String(i);
      frag.append(row);
    });
    if (state.results.length > MAX_RESULTS) {
      frag.append(el('div', { class: 'no-results' }, '… ' + (state.results.length - MAX_RESULTS) + ' more matches. Refine the search.'));
    }
    list.replaceChildren(frag);
    syncSelection(false);
    updateStatus();
  }

  // ===================================================================
  // Tooltip
  // ===================================================================

  // Shown after the pointer rests on a bookmark outside edit mode.
  const TIP_DELAY = 1000;
  const TIP_JITTER = 3;
  const tip = { el: null, link: null, timer: 0, x: 0, y: 0 };

  function hideTip() {
    clearTimeout(tip.timer);
    tip.timer = 0;
    tip.link = null;
    if (tip.el) tip.el.hidden = true;
  }

  function tipBookmark(link) {
    const item = link.closest('[data-bm-id]');
    return item ? findBm(findCat(state.data, item.dataset.catId), item.dataset.bmId) : null;
  }

  function showTip() {
    tip.timer = 0;
    const link = tip.link;
    const bm = link && link.isConnected && !state.editMode ? tipBookmark(link) : null;
    if (!bm) return;
    if (!tip.el) { tip.el = el('div', { class: 'tooltip', role: 'tooltip', hidden: true }); document.body.append(tip.el); }
    tip.el.replaceChildren(
      el('div', { class: 'tip-title' }, bm.title),
      el('div', { class: 'tip-url mono' }, bm.url),
      bm.description ? el('div', { class: 'tip-desc' }, bm.description) : null);
    tip.el.hidden = false;
    const r = tip.el.getBoundingClientRect();
    const p = tipPosition(tip.x, tip.y, r.width, r.height, window.innerWidth, window.innerHeight);
    tip.el.style.left = p.left + 'px';
    tip.el.style.top = p.top + 'px';
  }

  function onTipMove(e) {
    const link = state.editMode || !e.target.closest ? null : e.target.closest('a.tile-link, a.row-link');
    if (!link) { if (tip.link) hideTip(); return; }
    const shown = tip.el && !tip.el.hidden;
    if (link === tip.link && (shown || Math.abs(e.clientX - tip.x) + Math.abs(e.clientY - tip.y) <= TIP_JITTER)) return;
    hideTip();
    tip.link = link;
    tip.x = e.clientX;
    tip.y = e.clientY;
    tip.timer = setTimeout(showTip, TIP_DELAY);
  }

  // ===================================================================
  // Search (UI)
  // ===================================================================

  function onSearchInput() {
    const q = $('search').value;
    state.query = q.trim() ? q : '';
    state.results = state.query ? search(state.index, state.query) : [];
    state.sel = 0;
    $('btn-clear-search').disabled = q === '';
    renderSearchView();
  }

  function syncSelection(scroll) {
    const list = $('results');
    const input = $('search');
    const prev = list.querySelector('.result.selected');
    if (prev) { prev.classList.remove('selected'); prev.setAttribute('aria-selected', 'false'); }
    const cur = $('res-' + state.sel);
    if (cur) {
      cur.classList.add('selected');
      cur.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', cur.id);
      if (scroll) cur.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function moveSelection(delta) {
    const n = Math.min(state.results.length, MAX_RESULTS);
    if (!n) return;
    state.sel = (state.sel + delta + n) % n;
    syncSelection(true);
  }

  function openUrl(url) {
    const u = safeUrl(url);
    if (!u) { toast('Invalid or unsafe URL. Only http and https are allowed.', 'error'); return; }
    window.open(u.href, '_blank', 'noopener,noreferrer');
  }

  function clearSearch() {
    const input = $('search');
    input.value = '';
    onSearchInput();
  }

  function focusSearch(selectAll) {
    const input = $('search');
    if (isDialogOpen()) return;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    if (selectAll) input.select();
  }

  function onSearchKeydown(e) {
    if (e.isComposing) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveSelection(1); break;
      case 'ArrowUp': e.preventDefault(); moveSelection(-1); break;
      case 'PageDown': if (state.query) { e.preventDefault(); moveSelection(Math.min(10, Math.max(1, state.results.length - 1 - state.sel))); } break;
      case 'PageUp': if (state.query) { e.preventDefault(); moveSelection(-Math.min(10, state.sel)); } break;
      case 'Enter': {
        if (!state.query) break;
        e.preventDefault();
        const r = state.results[state.sel] || state.results[0];
        if (r) { openUrl(r.item.bm.url); recordVisit(r.item.bm.id); }
        else openUrl(fallbackTarget(state.query, searchTemplate()).url);
        break;
      }
      case 'Escape':
        e.preventDefault();
        if ($('search').value) clearSearch();
        break;
      case 'z':
      case 'Z':
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !$('search').value && canWrite()) {
          e.preventDefault();
          undo();
        }
        break;
      case 'F2': {
        const r = state.query && state.results[state.sel];
        if (r && canWrite()) { e.preventDefault(); openBookmarkDialog(r.item.cat.id, r.item.bm.id); }
        break;
      }
      default: break;
    }
  }

  function isEditable(t) {
    if (!t || !t.tagName) return false;
    return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
  }

  function isDialogOpen() { return !!document.querySelector('dialog[open]'); }

  function onGlobalKeydown(e) {
    if (isDialogOpen() || e.defaultPrevented) return;
    const t = e.target;
    if (t === $('search') || isEditable(t)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
      if (canWrite()) { e.preventDefault(); undo(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); focusSearch(true); return; }
    if (e.key === 'Escape') { if (state.query) clearSearch(); focusSearch(); return; }
    if (e.key.length === 1 && e.key !== ' ') focusSearch(); // the character goes into the search field
  }

  // ===================================================================
  // Drag & Drop
  // ===================================================================

  let drag = null;
  let dropTarget = null;

  function clearDropIndicators() {
    for (const n of $('categories').querySelectorAll('.drop-before,.drop-after,.drop-into,.drop-left,.drop-right')) {
      n.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-left', 'drop-right');
    }
  }

  function endDrag() {
    clearDropIndicators();
    for (const n of $('categories').querySelectorAll('.dragging')) n.classList.remove('dragging');
    drag = null;
    dropTarget = null;
  }

  function onDragStart(e) {
    const tile = e.target.closest ? e.target.closest('.item') : null;
    const bar = e.target.closest ? e.target.closest('.titlebar') : null;
    if (!tile && !bar) return;
    if (!canDnd()) { e.preventDefault(); return; }
    const panel = (tile || bar).closest('.panel');
    if (!panel || !panel.dataset.catId) { e.preventDefault(); return; }
    const dt = e.dataTransfer;
    if (tile) {
      const cat = findCat(state.data, tile.dataset.catId);
      const bm = findBm(cat, tile.dataset.bmId);
      if (!bm) { e.preventDefault(); return; }
      drag = { type: 'bm', catId: cat.id, bmId: bm.id };
      const u = safeUrl(bm.url);
      if (u) { dt.setData('text/uri-list', u.href); dt.setData('text/plain', u.href); } else dt.setData('text/plain', bm.title);
      tile.classList.add('dragging');
    } else {
      drag = { type: 'cat', catId: panel.dataset.catId };
      dt.setData('text/plain', panel.dataset.catId);
      try { dt.setDragImage(panel, 20, 10); } catch (err) { /* optional */ }
      panel.classList.add('dragging');
    }
    dt.effectAllowed = 'move';
  }

  function onDragOver(e) {
    if (!drag) return;
    clearDropIndicators();
    dropTarget = null;
    const panel = e.target.closest ? e.target.closest('.panel') : null;
    if (!panel || !panel.dataset.catId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const catId = panel.dataset.catId;
    if (drag.type === 'cat') {
      if (catId === drag.catId) return;
      const r = panel.getBoundingClientRect();
      const edge = Math.min(r.width * 0.3, 160);
      if (e.clientX < r.left + edge || e.clientX > r.right - edge) {
        const before = e.clientX < r.left + r.width / 2;
        panel.classList.add(before ? 'drop-left' : 'drop-right');
        dropTarget = { catId, before, sameRow: true };
      } else {
        const before = e.clientY < r.top + r.height / 2;
        const row = panel.closest('.cat-row') || panel;
        row.classList.add(before ? 'drop-before' : 'drop-after');
        dropTarget = { catId, before, sameRow: false };
      }
      return;
    }
    const item = e.target.closest('.item');
    if (item) {
      if (item.dataset.bmId === drag.bmId) return;
      const r = item.getBoundingClientRect();
      // tiles: left/right; detail rows: top/bottom
      const before = item.classList.contains('row')
        ? e.clientY < r.top + r.height / 2
        : e.clientX < r.left + r.width / 2;
      item.classList.add(before ? 'drop-before' : 'drop-after');
      dropTarget = { catId, refId: item.dataset.bmId, before };
    } else {
      panel.classList.add('drop-into');
      dropTarget = { catId, refId: null, before: false };
    }
  }

  function onDrop(e) {
    if (!drag) return;
    e.preventDefault();
    const d = drag;
    const t = dropTarget;
    endDrag();
    if (!t) return;
    if (d.type === 'cat') {
      commit(draft => moveCategory(draft, d.catId, t.catId, t.before, t.sameRow), 'Category moved');
    } else {
      commit(draft => moveBookmark(draft, d.catId, d.bmId, t.catId, t.refId, t.before), 'Bookmark moved');
    }
  }

  // ===================================================================
  // Modals
  // ===================================================================

  // opts: {title, body: Node|Node[], buttons: [{label, value, primary, submit}], onSubmit, initialFocus}
  function showDialog(opts) {
    return new Promise(resolve => {
      const prevFocus = document.activeElement;
      const dlg = el('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' });
      const form = el('form', { class: 'dlg-form', novalidate: true });
      const bar = el('div', { class: 'titlebar' },
        el('span', { class: 'wm-btn win-menu', 'aria-hidden': 'true' }),
        el('h2', { class: 'title-text', id: 'dlg-title' }, opts.title),
        el('span', { class: 'wm-btn win-min', 'aria-hidden': 'true' }),
        el('span', { class: 'wm-btn win-max', 'aria-hidden': 'true' }));
      const content = el('div', { class: 'dlg-content' });
      for (const n of [].concat(opts.body || [])) if (n) content.append(n);
      const err = el('p', { class: 'dlg-error', role: 'alert', hidden: true });
      content.append(err);
      const btnRow = el('div', { class: 'dlg-buttons' });
      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        if (dlg.open) dlg.close();
        dlg.remove();
        if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) prevFocus.focus({ preventScroll: true });
        else focusSearch();
        resolve(v);
      };
      let focusBtn = null;
      for (const b of opts.buttons) {
        const btn = el('button', { type: b.submit ? 'submit' : 'button', class: 'btn' + (b.primary ? ' default' : '') }, b.label);
        if (!b.submit) btn.addEventListener('click', () => finish(b.value));
        if (b.focus) focusBtn = btn;
        btnRow.append(btn);
      }
      form.addEventListener('submit', e => {
        e.preventDefault();
        if (!opts.onSubmit) { finish(true); return; }
        const r = opts.onSubmit();
        if (r && r.error) {
          err.textContent = r.error;
          err.hidden = false;
          if (r.field) { r.field.focus(); if (r.field.select) r.field.select(); }
          return;
        }
        finish(r ? r.value : true);
      });
      dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
      dlg.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      });
      form.append(bar, content, btnRow);
      dlg.append(form);
      document.body.append(dlg);
      dlg.showModal();
      const first = focusBtn || opts.initialFocus || content.querySelector('input,select,textarea') || btnRow.querySelector('.default') || btnRow.querySelector('button');
      if (first) first.focus();
    });
  }

  async function openOptionsDialog() {
    const fTpl = el('input', { type: 'text', class: 'field mono', autocomplete: 'off', spellcheck: 'false', placeholder: DEFAULT_SEARCH_TEMPLATE });
    fTpl.value = searchTemplate();
    const code = bookmarkletCode();
    const fBml = el('input', { type: 'text', class: 'field mono', readonly: true, spellcheck: 'false' });
    fBml.value = code;
    const bmlRow = formRow('Bookmarklet', fBml, 'Create a browser bookmark with this text as its URL. Clicking it adds the open page here.');
    const copyBtn = el('button', { type: 'button', class: 'btn' }, 'Copy');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(code).then(() => toast('Bookmarklet copied.'), () => { fBml.focus(); fBml.select(); });
    });
    const bmlField = bmlRow.querySelector('.form-field');
    bmlField.insertBefore(copyBtn, bmlField.querySelector('.hint'));
    const searchRow = el('div', { class: 'form-row' }, el('span', { class: 'form-label' }, 'Address bar'),
      el('div', { class: 'form-field' }, el('small', { class: 'hint' },
        'This page offers the search engine “Bookmarks” to the browser. Add it there and give it a keyword. ' +
        'A search opens the best match directly, or this page with the results.')));
    const v = await showDialog({
      title: 'Options',
      body: [formRow('Search engine', fTpl, '%s is replaced by the search term. Used for Enter without matches. Default: ' + DEFAULT_SEARCH_TEMPLATE), bmlRow, searchRow],
      initialFocus: fTpl,
      buttons: [{ label: 'OK', submit: true, primary: true }, { label: 'Default', value: 'reset' }, { label: 'Cancel', value: null }],
      onSubmit: () => {
        const t = fTpl.value.trim();
        if (!isValidSearchTemplate(t)) return { error: 'Please enter an http(s) URL containing %s, e.g. ' + DEFAULT_SEARCH_TEMPLATE, field: fTpl };
        return { value: t };
      }
    });
    if (!v) return;
    if (v === 'reset') { try { localStorage.removeItem(LS_SEARCH); } catch (e) { /* Policy */ } }
    else lsSet(LS_SEARCH, v);
    toast('Search engine: ' + searchTemplate());
    if (state.query) renderSearchView();
  }

  function confirmDialog(title, message, okLabel) {
    return showDialog({
      title,
      body: el('div', { class: 'dlg-message' }, el('span', { class: 'dlg-icon dlg-icon-warn', 'aria-hidden': 'true' }, '!'), el('p', null, message)),
      buttons: [
        { label: okLabel || 'OK', value: true, primary: true },
        { label: 'Cancel', value: false, focus: true }
      ]
    }).then(v => v === true);
  }

  function formRow(label, input, hint) {
    const id = 'f-' + uuid().slice(0, 8);
    input.id = id;
    return el('div', { class: 'form-row' },
      el('label', { for: id }, label),
      el('div', { class: 'form-field' }, input, hint ? el('small', { class: 'hint' }, hint) : null));
  }

  function sameUrl(a, b) {
    const ua = safeUrl(a);
    const ub = safeUrl(b);
    return !!ua && !!ub && ua.href.replace(/\/$/, '') === ub.href.replace(/\/$/, '');
  }

  function findDuplicate(url, exceptId) {
    for (const cat of state.data.categories) {
      for (const bm of cat.bookmarks) {
        if (bm.id !== exceptId && sameUrl(bm.url, url)) return { cat, bm };
      }
    }
    return null;
  }

  function bookmarkletCode() {
    return "javascript:void(window.open('" + location.origin +
      "/?add='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)))";
  }

  // prefill: optional {url, title} for a new bookmark
  async function openBookmarkDialog(catId, bmId, prefill) {
    if (!canWrite()) return;
    const cats = state.data.categories;
    const cat = catId ? findCat(state.data, catId) : null;
    const bm = bmId ? findBm(cat, bmId) : null;
    if (bmId && !bm) return;

    const fTitle = el('input', { type: 'text', class: 'field', maxlength: MAX_TITLE, autocomplete: 'off' });
    const fUrl = el('input', { type: 'text', class: 'field mono', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://…' });
    const fTags = el('input', { type: 'text', class: 'field', autocomplete: 'off', placeholder: 'e.g. work, ticket' });
    const fDesc = el('textarea', { class: 'field', rows: 3, maxlength: MAX_DESC });
    fDesc.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fDesc.form.requestSubmit(); }
    });
    const fCat = el('select', { class: 'field' });
    if (cats.length) {
      for (const c of cats) fCat.append(el('option', { value: c.id }, c.name));
      fCat.value = (cat || cats[0]).id;
    } else {
      fCat.append(el('option', { value: '__new__' }, 'General (new)'));
    }
    if (bm) { fTitle.value = bm.title; fUrl.value = bm.url; fTags.value = bm.tags.join(', '); fDesc.value = bm.description || ''; }
    else if (prefill) { fTitle.value = prefill.title; fUrl.value = prefill.url; }
    let dupConfirmed = null;
    fUrl.addEventListener('blur', () => {
      if (!fTitle.value.trim()) { const n = normalizeUrlInput(fUrl.value); if (n) fTitle.value = safeUrl(n).hostname.replace(/^www\./, ''); }
    });

    const value = await showDialog({
      title: bm ? 'Edit bookmark' : 'New bookmark',
      body: [formRow('Title', fTitle), formRow('URL', fUrl, 'Without a scheme, https:// is added.'), formRow('Tags', fTags, 'Comma-separated'), formRow('Description', fDesc, 'Shown when the pointer rests on the bookmark.'), formRow('Category', fCat)],
      initialFocus: bm || prefill ? fTitle : fUrl,
      buttons: [{ label: 'OK', submit: true, primary: true }, { label: 'Cancel', value: null }],
      onSubmit: () => {
        const url = normalizeUrlInput(fUrl.value);
        if (!url) return { error: 'Please enter a valid http or https URL.', field: fUrl };
        const dup = findDuplicate(url, bm ? bm.id : null);
        if (dup && dupConfirmed !== url) {
          dupConfirmed = url;
          return { error: 'This URL is already saved as “' + dup.bm.title + '” in “' + dup.cat.name + '”. Press OK again to save it anyway.', field: fUrl };
        }
        const title = fTitle.value.replace(/\s+/g, ' ').trim() || safeUrl(url).hostname.replace(/^www\./, '');
        return { value: { title, url, tags: parseTags(fTags.value), description: cleanDescription(fDesc.value), catId: fCat.value } };
      }
    });
    if (!value) return;

    commit(draft => {
      let target = findCat(draft, value.catId);
      if (!target) {
        target = { id: uuid(), name: 'General', order: draft.categories.length, bookmarks: [] };
        draft.categories.push(target);
      }
      if (bm) {
        const src = findCat(draft, cat.id);
        const cur = findBm(src, bm.id);
        if (!cur) return false;
        cur.title = value.title; cur.url = value.url; cur.tags = value.tags;
        if (value.description) cur.description = value.description; else delete cur.description;
        if (src.id !== target.id) {
          src.bookmarks.splice(src.bookmarks.indexOf(cur), 1);
          target.bookmarks.push(cur);
        }
      } else {
        const nb = { id: uuid(), title: value.title, url: value.url, tags: value.tags, order: target.bookmarks.length };
        if (value.description) nb.description = value.description;
        target.bookmarks.push(nb);
      }
      return true;
    }, bm ? 'Bookmark saved' : 'Bookmark created');
  }

  async function openCategoryDialog(catId) {
    if (!canWrite()) return;
    const cat = catId ? findCat(state.data, catId) : null;
    if (catId && !cat) return;
    const fName = el('input', { type: 'text', class: 'field', maxlength: 200, autocomplete: 'off' });
    if (cat) fName.value = cat.name;
    const name = await showDialog({
      title: cat ? 'Edit category' : 'New category',
      body: [formRow('Name', fName)],
      buttons: [{ label: 'OK', submit: true, primary: true }, { label: 'Cancel', value: null }],
      onSubmit: () => {
        const n = fName.value.replace(/\s+/g, ' ').trim();
        if (!n) return { error: 'Please enter a name.', field: fName };
        const dup = state.data.categories.find(c => c.id !== catId && c.name.trim().toLowerCase() === n.toLowerCase());
        if (dup) return { error: 'A category with this name already exists.', field: fName };
        return { value: n };
      }
    });
    if (!name) return;
    commit(draft => {
      if (cat) {
        const c = findCat(draft, cat.id);
        if (!c) return false;
        c.name = name;
      } else {
        draft.categories.push({ id: uuid(), name, order: draft.categories.length, bookmarks: [] });
      }
      return true;
    }, cat ? 'Category renamed' : 'Category created');
  }

  async function deleteCategory(catId) {
    const cat = findCat(state.data, catId);
    if (!cat || !canWrite()) return;
    const n = cat.bookmarks.length;
    const ok = await confirmDialog('Delete category',
      'Really delete category “' + cat.name + '”' + (n ? ' with ' + n + (n === 1 ? ' bookmark' : ' bookmarks') : '') + '?', 'Delete');
    if (!ok) return;
    commit(draft => removeCategory(draft, catId), 'Category deleted');
  }

  async function deleteBookmark(catId, bmId) {
    const cat = findCat(state.data, catId);
    const bm = findBm(cat, bmId);
    if (!bm || !canWrite()) return;
    const ok = await confirmDialog('Delete bookmark', 'Really delete bookmark “' + bm.title + '”?', 'Delete');
    if (!ok) return;
    commit(draft => {
      const c = findCat(draft, catId);
      const i = c ? c.bookmarks.findIndex(b => b.id === bmId) : -1;
      if (i < 0) return false;
      c.bookmarks.splice(i, 1);
      return true;
    }, 'Bookmark deleted');
  }

  // ===================================================================
  // Toasts
  // ===================================================================

  // action: optional {label, run} shown as a button in the toast.
  function toast(msg, kind, action) {
    kind = kind || 'info';
    const box = $('toasts');
    const label = kind === 'error' ? 'Error' : kind === 'warn' ? 'Warning' : 'Notice';
    const body = el('div', { class: 'toast-body' }, msg);
    const t = el('div', { class: 'toast toast-' + kind, role: kind === 'error' ? 'alert' : 'status' },
      el('div', { class: 'titlebar' },
        el('span', { class: 'wm-btn win-menu', 'aria-hidden': 'true' }),
        el('span', { class: 'title-text' }, label)),
      body);
    if (action) {
      const btn = el('button', { type: 'button', class: 'btn toast-action' }, action.label);
      btn.addEventListener('click', e => { e.stopPropagation(); t.remove(); action.run(); });
      body.append(' ', btn);
    }
    t.addEventListener('click', () => t.remove());
    box.append(t);
    while (box.children.length > 4) box.firstElementChild.remove();
    setTimeout(() => t.remove(), action ? 8000 : kind === 'error' ? 8000 : kind === 'warn' ? 6000 : 3500);
  }

  // ===================================================================
  // Import / Export
  // ===================================================================

  async function onImportFile(file) {
    if (!file || !canWrite()) return;
    if (file.size > MAX_IMPORT_BYTES) { toast('File is too large (max. 20 MB).', 'error'); return; }
    let imported;
    try {
      const text = await file.text();
      const isJson = /\.json$/i.test(file.name) || /^\s*[{[]/.test(text);
      imported = isJson ? parseOwnJson(text) : parseNetscape(text);
    } catch (e) {
      toast('Import failed: ' + (e && e.message ? e.message : e), 'error');
      return;
    }
    const nBm = imported.categories.reduce((s, c) => s + c.bookmarks.length, 0);
    const nCat = imported.categories.length;
    if (!nCat) { toast('No importable bookmarks found.', 'error'); return; }
    const msg = 'Found ' + nBm + (nBm === 1 ? ' bookmark' : ' bookmarks') + ' in ' + nCat + (nCat === 1 ? ' category' : ' categories') +
      (imported.skipped ? ' (' + imported.skipped + ' skipped: not an http/https URL or invalid)' : '') + '.';
    const mode = await showDialog({
      title: 'Import: ' + file.name,
      body: [
        el('div', { class: 'dlg-message' }, el('span', { class: 'dlg-icon', 'aria-hidden': 'true' }, 'i'),
          el('div', null,
            el('p', null, msg),
            el('p', null, '“Merge” extends categories with the same name and skips duplicate URLs.'),
            el('p', null, '“Replace” discards all existing bookmarks.')))
      ],
      buttons: [
        { label: 'Merge', value: 'merge', primary: true },
        { label: 'Replace', value: 'replace' },
        { label: 'Cancel', value: null }
      ]
    });
    if (!mode) return;
    let stats = null;
    commit(draft => { stats = applyImport(draft, imported, mode); return true; },
      () => 'Import complete: ' + stats.added + ' added' +
        (stats.duplicates ? ', ' + stats.duplicates + ' duplicates skipped' : '') +
        (stats.newCategories ? ', ' + stats.newCategories + (stats.newCategories === 1 ? ' new category' : ' new categories') : ''));
    if (stats && stats.added === 0 && mode === 'merge') toast('No new bookmarks. Everything already exists.', 'info');
  }

  function exportJson() {
    const data = renumber(clone(state.data));
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const d = new Date();
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'bookmarks-' + ymd + '.json', hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ===================================================================
  // Theme
  // ===================================================================

  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function themePref() {
    const p = lsGet(LS_THEME);
    return THEMES.includes(p) ? p : 'auto';
  }

  function applyTheme() {
    const pref = themePref();
    const eff = pref === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : pref;
    document.documentElement.setAttribute('data-theme', eff);
    document.documentElement.setAttribute('data-theme-pref', pref);
    const btn = $('btn-theme');
    if (btn) btn.textContent = 'Theme: ' + THEME_LABEL[pref];
  }

  function cycleTheme() {
    const p = themePref();
    lsSet(LS_THEME, THEMES[(THEMES.indexOf(p) + 1) % THEMES.length]);
    applyTheme();
  }

  // ===================================================================
  // Font size & view
  // ===================================================================

  const FS_MIN = 10;
  const FS_MAX = 24;
  const FS_DEFAULT = 12;

  function fontSize() {
    const n = parseInt(lsGet(LS_FONT), 10);
    return Number.isFinite(n) ? Math.min(FS_MAX, Math.max(FS_MIN, n)) : FS_DEFAULT;
  }

  function applyFontSize() {
    const fs = fontSize();
    document.documentElement.style.setProperty('--ui-fs', fs + 'px');
    const out = $('fs-value');
    if (out) {
      out.textContent = fs + ' px';
      $('btn-font-dec').disabled = fs <= FS_MIN;
      $('btn-font-inc').disabled = fs >= FS_MAX;
      $('btn-font-reset').disabled = fs === FS_DEFAULT;
    }
  }

  function changeFontSize(delta) {
    const fs = delta === 0 ? FS_DEFAULT : Math.min(FS_MAX, Math.max(FS_MIN, fontSize() + delta));
    lsSet(LS_FONT, String(fs));
    applyFontSize();
  }

  function viewPref() { return lsGet(LS_VIEW) === 'details' ? 'details' : 'tiles'; }

  function setView(v) {
    if (v === state.view) return;
    state.view = v;
    lsSet(LS_VIEW, v);
    updateChrome();
    renderCategories();
  }

  // ===================================================================
  // Init
  // ===================================================================

  function updateClock() {
    const now = new Date();
    $('clock-time').textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    $('clock-date').textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: '2-digit' });
  }

  function onCategoriesClick(e) {
    const actEl = e.target.closest('[data-action]');
    const panel = e.target.closest('.panel');
    const catId = panel ? panel.dataset.catId : null;
    const tile = e.target.closest('.item');
    const bmId = tile ? tile.dataset.bmId : null;
    if (actEl) {
      e.preventDefault();
      switch (actEl.dataset.action) {
        case 'add-bm': openBookmarkDialog(catId, null); break;
        case 'edit-cat': openCategoryDialog(catId); break;
        case 'del-cat': deleteCategory(catId); break;
        case 'edit-bm': openBookmarkDialog(catId, bmId); break;
        case 'del-bm': deleteBookmark(catId, bmId); break;
        case 'toggle-collapse': toggleCollapse(catId); break;
        case 'empty-add-cat': openCategoryDialog(null); break;
        case 'empty-import': $('file-input').click(); break;
        default: break;
      }
      return;
    }
    if (tile && state.editMode && canWrite()) {
      e.preventDefault();
      openBookmarkDialog(catId, bmId);
      return;
    }
    const link = e.target.closest('a.tile-link, a.row-link');
    if (link && !link.hasAttribute('href')) {
      e.preventDefault();
      toast('Invalid or unsafe URL. Only http and https are allowed.', 'error');
      return;
    }
    visitFromEvent(e);
  }

  function onResultsClick(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const catId = row.dataset.catId;
    const bmId = row.dataset.bmId;
    const actEl = e.target.closest('[data-action]');
    if (actEl) {
      e.preventDefault();
      if (actEl.dataset.action === 'edit-bm') openBookmarkDialog(catId, bmId);
      else if (actEl.dataset.action === 'del-bm') deleteBookmark(catId, bmId);
      return;
    }
    if (state.editMode && canWrite()) {
      e.preventDefault();
      openBookmarkDialog(catId, bmId);
      return;
    }
    const link = e.target.closest('a.row-link');
    if (link && !link.hasAttribute('href')) {
      e.preventDefault();
      toast('Invalid or unsafe URL. Only http and https are allowed.', 'error');
      return;
    }
    visitFromEvent(e);
  }

  // Middle click opens a link without a click event.
  function onAuxClick(e) {
    if (e.button === 1 && !state.editMode) visitFromEvent(e);
  }

  // ?add=<url>&title=<title> (bookmarklet) prefills the bookmark dialog; nothing
  // is saved without OK. ?q=<terms> (address bar search) opens a strong match directly.
  async function handleUrlParams() {
    const p = new URLSearchParams(location.search);
    const q = p.get('q');
    const add = p.get('add');
    if (q === null && add === null) return;
    history.replaceState(null, '', location.pathname);
    if (add !== null) {
      if (!canWrite()) { toast('Read-only. The page cannot be added now.', 'error'); return; }
      const url = normalizeUrlInput(add);
      if (!url) { toast('Invalid or unsafe URL. Only http and https are allowed.', 'error'); return; }
      openBookmarkDialog(null, null, { url, title: cleanTitle(p.get('title'), url) });
      return;
    }
    $('search').value = q;
    onSearchInput();
    const best = state.results[0];
    const u = best && best.minTerm >= STRONG_MATCH ? safeUrl(best.item.bm.url) : null;
    if (!u) return;
    if (canWrite()) await Promise.race([recordVisit(best.item.bm.id), new Promise(r => setTimeout(r, 1500))]);
    location.replace(u.href);
  }

  function toggleCollapse(catId) {
    if (!catId) return;
    if (collapsed.has(catId)) collapsed.delete(catId); else collapsed.add(catId);
    saveCollapsed();
    const panel = $('categories').querySelector('.panel[data-cat-id="' + CSS.escape(catId) + '"]');
    if (!panel) return;
    const isCol = collapsed.has(catId);
    panel.classList.toggle('collapsed', isCol);
    panel.querySelector('.panel-body').hidden = isCol;
    const btn = panel.querySelector('.win-min');
    const cat = findCat(state.data, catId);
    btn.setAttribute('aria-expanded', String(!isCol));
    btn.title = isCol ? 'Expand' : 'Collapse';
    btn.setAttribute('aria-label', (isCol ? 'Expand: ' : 'Collapse: ') + (cat ? cat.name : ''));
  }

  function init() {
    applyTheme();
    applyFontSize();
    if (mq) {
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
      else if (mq.addListener) mq.addListener(applyTheme);
    }
    loadCollapsed();
    updateClock();
    setInterval(updateClock, 15000);

    const input = $('search');
    input.addEventListener('input', onSearchInput);
    input.addEventListener('keydown', onSearchKeydown);
    $('btn-clear-search').addEventListener('click', () => { clearSearch(); focusSearch(); });
    document.addEventListener('keydown', onGlobalKeydown);
    window.addEventListener('focus', () => {
      if (isDialogOpen()) return;
      focusSearch();
      if (state.loaded && !state.readOnly && state.pending === 0) load();
    });

    const results = $('results');
    results.addEventListener('click', onResultsClick);
    results.addEventListener('auxclick', onAuxClick);
    results.addEventListener('mousemove', e => {
      const row = e.target.closest('.result');
      if (row && Number(row.dataset.index) !== state.sel) { state.sel = Number(row.dataset.index); syncSelection(false); }
    });

    const cats = $('categories');
    cats.addEventListener('click', onCategoriesClick);
    cats.addEventListener('auxclick', onAuxClick);
    cats.addEventListener('dblclick', e => {
      const bar = e.target.closest('.titlebar');
      if (bar && !e.target.closest('button')) { const p = bar.closest('.panel'); if (p) toggleCollapse(p.dataset.catId); }
    });
    cats.addEventListener('dragstart', onDragStart);
    cats.addEventListener('dragover', onDragOver);
    cats.addEventListener('drop', onDrop);
    cats.addEventListener('dragend', endDrag);

    $('btn-add-bookmark').addEventListener('click', () => openBookmarkDialog(null, null));
    $('btn-add-category').addEventListener('click', () => openCategoryDialog(null));
    $('btn-edit').addEventListener('click', () => { state.editMode = !state.editMode; hideTip(); updateChrome(); });
    document.addEventListener('mousemove', onTipMove, { passive: true });
    for (const ev of ['mousedown', 'keydown', 'dragstart', 'wheel']) document.addEventListener(ev, hideTip, { capture: true, passive: true });
    window.addEventListener('scroll', hideTip, { capture: true, passive: true });
    window.addEventListener('blur', hideTip);
    document.documentElement.addEventListener('mouseleave', hideTip);
    $('btn-import').addEventListener('click', () => { if (canWrite()) $('file-input').click(); });
    $('btn-export').addEventListener('click', exportJson);
    $('btn-options').addEventListener('click', openOptionsDialog);
    $('btn-theme').addEventListener('click', cycleTheme);
    $('btn-view-tiles').addEventListener('click', () => setView('tiles'));
    $('btn-view-details').addEventListener('click', () => setView('details'));
    $('btn-font-dec').addEventListener('click', () => changeFontSize(-1));
    $('btn-font-inc').addEventListener('click', () => changeFontSize(1));
    $('btn-font-reset').addEventListener('click', () => changeFontSize(0));
    $('file-input').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      onImportFile(f);
    });
    $('btn-retry').addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const ok = await load();
      btn.disabled = false;
      toast(ok ? 'Connection restored.' : (state.loadError ? 'Server error: ' + state.loadError : 'Server still not reachable.'), ok ? 'info' : 'error');
    });

    // Show the cache immediately (fast start page); server data replaces it afterwards.
    const c = readCache();
    if (c) {
      state.hasCache = true;
      state.data = normalizeData(c.data);
      state.etag = c.etag || null;
      reindex();
      render();
    }
    focusSearch();
    load().then(() => { focusSearch(); return handleUrlParams(); });
  }

  // Set theme and font size immediately (the script runs in <head>) to avoid flicker.
  applyTheme();
  applyFontSize();
  state.view = viewPref();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
