// mobile-cc-turns — pseudo message-containers in the terminal (P1).
//
// Ports tmux-web's Wpin7 _wp7CorrelateJsonlToRows into the mobile-cc cell-grid:
// correlate CC JSONL turns to ranges of .ttv-row, tag the rows, and DECORATE
// them so the raw terminal gains visible message structure.
//
//   • correlate: share the marker scanner (window.mccMarkers — '❯' user / '●'
//     assistant, chrome-clamped); match each user prompt row to a user entry
//     from /panes/:id/cc-transcript; a turn is CONFIRMED only on a high-
//     confidence text match (bias: wrong > absent → unmatched rows stay plain).
//   • tag: data-mcc-turn / data-mcc-role on every row of a confirmed turn;
//     .mcc-turn-start on the prompt row, .mcc-turn-end on the turn's last row.
//   • P1 decorations: role TINT + turn SEPARATOR (layout-neutral CSS) + a
//     per-turn TIMESTAMP (honest CC-transcript time = when you sent it),
//     ::after the prompt's last row.
//
// Inherited tmux-web fixes (load-bearing): 2s STABILITY gate (don't stamp a
// still-streaming entry), CONTENT-VALIDATED sticky (a cell-grid row stays in
// the DOM but its text gets rewritten in place — re-validate the row still
// holds the entry's text before keeping its stamp, else recompute), MULTI-
// PATTERN truncation (so a width-truncated TUI line still matches), marker
// DEDUP (via the shared scanner), DIFF-PASS (mutate only changed rows → no
// reflow churn each tick).
//
// Fully toggleable (Settings → Message Regions, default ON): off → every tag +
// decoration is removed and the terminal reverts to plain.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-turns] requires apiVersion 1');
    return;
  }
  var SELF = tv.storage('mobile-cc-turns');
  var TS_STABLE_MS = 2000;

  function diag(cat, data) {
    try { if (typeof window.ttvDiag === 'function') window.ttvDiag(cat, data); } catch (e) {}
  }
  function enabled() {
    var v = SELF.get('enabled');
    return (v === undefined || v === null) ? true : !!v;
  }

  function injectStyle() {
    if (document.getElementById('mcc-turns-styles')) return;
    var s = document.createElement('style');
    s.id = 'mcc-turns-styles';
    // Per-turn TIMESTAMP only. The role TINT + turn SEPARATOR were dropped (user
    // call: visual noise + inconsistent since only high-confidence turns get
    // decorated). The correlation/tagging still runs to place the timestamp; the
    // data-mcc-role/turn + .mcc-turn-start/end attributes just carry no styling.
    s.textContent =
      // per-turn timestamp, right-aligned after the prompt's last row. Absolute
      // → out of flow → no layout shift; its own bg masks any text underneath.
      '.ttv-row[data-mcc-ts]{position:relative;}' +
      '.ttv-row[data-mcc-ts]::after{content:attr(data-mcc-ts);position:absolute;right:2px;top:0;' +
        'font:10px/1.7 system-ui,sans-serif;color:var(--ttv-muted,#9aa);opacity:.85;pointer-events:none;' +
        'background:var(--ttv-bg,#1e1e1e);padding:0 4px;border-radius:4px;}';
    document.head.appendChild(s);
  }

  // ---- transcript (user entries) ----------------------------------------
  function activePaneId() {
    try { var p = tv.getActivePane && tv.getActivePane(); return (p && p.id) || null; } catch (e) { return null; }
  }
  function extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      var out = '';
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (b && b.type === 'text' && typeof b.text === 'string') out += (out ? ' ' : '') + b.text;
      }
      return out;
    }
    return '';
  }
  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  // Multiple prefix slices so at least one survives the TUI's width truncation.
  function patternsOf(textNorm) {
    var out = [], lens = [80, 48, 28, 16];
    for (var i = 0; i < lens.length; i++) {
      var p = textNorm.slice(0, lens[i]);
      if (p.length >= 8 && out.indexOf(p) < 0) out.push(p);
    }
    return out;
  }
  function parseUserEntries(d) {
    var turns = d && d.turns;
    if (!Array.isArray(turns)) return [];
    var out = [], cur = null;
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (!t || !t.message) continue;
      if (t.type === 'user') {
        var txt = extractText(t.message.content);
        var tn = norm(txt);
        if (!tn || tn.indexOf('[cc-com]') === 0) continue;   // tool-result / cc-com → not a prompt
        cur = { uuid: t.uuid, ts: t.timestamp, norm: tn, patterns: patternsOf(tn), responseTs: null };
        out.push(cur);
      } else if (t.type === 'assistant' && cur && t.timestamp) {
        cur.responseTs = t.timestamp;            // latest assistant entry in the turn = cc's reply time
      }
    }
    return out;                                  // oldest → newest, each w/ its cc responseTs
  }

  // transcript cache: { paneId, entries, at, loading }
  var tc = null;
  function ensureTranscript(cb) {
    var id = activePaneId();
    if (!id) { cb(null); return; }
    if (tc && tc.paneId === id && tc.entries && (Date.now() - tc.at) < 3000) { cb(tc.entries); return; }
    if (tc && tc.paneId === id && tc.loading) { cb(tc.entries || null); return; }
    tc = { paneId: id, entries: (tc && tc.paneId === id) ? tc.entries : null, at: tc ? tc.at : 0, loading: true };
    fetch('/panes/' + encodeURIComponent(id) + '/cc-transcript?tail=300')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { tc = { paneId: id, entries: parseUserEntries(d), at: Date.now(), loading: false }; cb(tc.entries); })
      .catch(function () { if (tc) tc.loading = false; cb(tc && tc.entries || null); });
  }

  // ---- matching ---------------------------------------------------------
  function matchScore(postNorm, entry) {
    if (!postNorm) return 0;
    var best = 0;
    for (var i = 0; i < entry.patterns.length; i++) {
      var p = entry.patterns[i];
      var a = postNorm.slice(0, 16), b = p.slice(0, 16);
      if (postNorm.indexOf(p) === 0 || p.indexOf(a) === 0 || postNorm.indexOf(b) === 0) {
        if (p.length > best) best = p.length;
      }
    }
    return best;
  }
  var MIN_SCORE = 10;   // high-confidence threshold

  // ---- correlate + tag --------------------------------------------------
  // Currently-applied state, for diff-pass.
  var curTags = new Map();   // rowEl -> 'user'|'assistant' (data-mcc-role)
  var curTurn = new Map();   // rowEl -> turn seq string
  var curStart = new Set();  // rowEl with .mcc-turn-start
  var curEnd = new Set();    // rowEl with .mcc-turn-end
  var curTs = new Map();     // rowEl -> ts string
  var stickyByUuid = new Map(); // uuid -> { row, pattern }

  function lastNonBlank(rows, lo, hi) {       // [lo,hi) → last row with text, else lo
    for (var r = hi - 1; r >= lo; r--) {
      if ((rows[r].textContent || '').trim()) return r;
    }
    return lo;
  }
  function stickyValid(rowEl, host, pattern) {
    if (!rowEl || !host.contains(rowEl)) return false;
    if (!pattern || pattern.length < 8) return false;
    return norm(rowEl.textContent).indexOf(pattern.slice(0, Math.min(pattern.length, 24))) >= 0;
  }

  function clearAll() {
    var host = document.getElementById('grid-host');
    if (host) {
      var marked = host.querySelectorAll('[data-mcc-turn],[data-mcc-role],[data-mcc-ts],.mcc-turn-start,.mcc-turn-end');
      for (var i = 0; i < marked.length; i++) {
        var el = marked[i];
        el.removeAttribute('data-mcc-turn'); el.removeAttribute('data-mcc-role'); el.removeAttribute('data-mcc-ts');
        el.classList.remove('mcc-turn-start', 'mcc-turn-end');
      }
    }
    curTags = new Map(); curTurn = new Map(); curStart = new Set(); curEnd = new Set(); curTs = new Map();
    stickyByUuid = new Map();
  }

  function correlate() {
    if (!enabled()) { return; }
    var host = document.getElementById('grid-host');
    if (!host || !window.mccMarkers) return;
    ensureTranscript(function (userEntries) {
      if (!userEntries || !userEntries.length) return;   // no truth yet → leave as-is
      doCorrelate(host, userEntries);
    });
  }

  function doCorrelate(host, userEntries) {
    var sc = window.mccMarkers.scan(host);
    var markers = sc.markers, rows = sc.rows, chromeStart = sc.chromeStart;

    // Build turn skeletons from user markers.
    var turns = [];
    for (var k = 0; k < markers.length; k++) {
      if (markers[k].role !== 'user') continue;
      var startRow = markers[k].idx;
      var endRow = chromeStart, firstAssist = -1;
      for (var m = k + 1; m < markers.length; m++) {
        if (markers[m].idx >= chromeStart) break;
        if (markers[m].role === 'user') { endRow = markers[m].idx; break; }
        if (markers[m].role === 'assistant' && firstAssist < 0) firstAssist = markers[m].idx;
      }
      if (firstAssist < 0 || firstAssist >= endRow) firstAssist = endRow;
      turns.push({ marker: markers[k], startRow: startRow, endRow: endRow, userBlockEnd: firstAssist, entry: null });
    }

    // Match bottom-up (both lists chronological, bottom = certain).
    var ptr = userEntries.length - 1;
    for (var ti = turns.length - 1; ti >= 0; ti--) {
      var post = norm(turns[ti].marker.post);
      for (var e = ptr; e >= 0; e--) {
        if (matchScore(post, userEntries[e]) >= MIN_SCORE) { turns[ti].entry = userEntries[e]; ptr = e - 1; break; }
      }
    }

    // Build the new plan (confirmed turns only).
    var nTags = new Map(), nTurn = new Map(), nStart = new Set(), nEnd = new Set(), nTs = new Map();
    var seq = 0, confirmed = 0;
    for (var t = 0; t < turns.length; t++) {
      var tn = turns[t];
      if (!tn.entry) continue;                 // unmatched → plain
      confirmed++;
      var sid = String(seq++);
      var r;
      for (r = tn.startRow; r < tn.userBlockEnd; r++) { nTags.set(rows[r], 'user'); nTurn.set(rows[r], sid); }
      for (r = tn.userBlockEnd; r < tn.endRow; r++) { nTags.set(rows[r], 'assistant'); nTurn.set(rows[r], sid); }
      nStart.add(rows[tn.startRow]);
      nEnd.add(rows[lastNonBlank(rows, tn.startRow, tn.endRow)]);
      // USER message timestamp: 2s-stable + content-validated sticky, on the
      // prompt's last row.
      var ms = tn.entry.ts ? Date.parse(tn.entry.ts) : NaN;
      if (!isNaN(ms) && (Date.now() - ms) > TS_STABLE_MS) {
        var freshRow = rows[lastNonBlank(rows, tn.startRow, tn.userBlockEnd)];
        var stick = stickyByUuid.get(tn.entry.uuid);
        var stampRow = (stick && stickyValid(stick.row, host, stick.pattern)) ? stick.row : freshRow;
        stickyByUuid.set(tn.entry.uuid, { row: stampRow, pattern: tn.entry.patterns[0] || tn.entry.norm });
        nTs.set(stampRow, fmtTs(tn.entry.ts));
      }
      // CC (assistant) message timestamp: the turn's last assistant entry, on
      // the assistant block's last row — so every message, user OR cc, is timed.
      if (tn.userBlockEnd < tn.endRow && tn.entry.responseTs) {
        var ams = Date.parse(tn.entry.responseTs);
        if (!isNaN(ams) && (Date.now() - ams) > TS_STABLE_MS) {
          var aFresh = rows[lastNonBlank(rows, tn.userBlockEnd, tn.endRow)];
          var aKey = tn.entry.uuid + ':a';
          var aPat = norm((rows[tn.userBlockEnd] && rows[tn.userBlockEnd].textContent) || '').slice(0, 24);
          var aStick = stickyByUuid.get(aKey);
          var aRow = (aStick && stickyValid(aStick.row, host, aStick.pattern)) ? aStick.row : aFresh;
          stickyByUuid.set(aKey, { row: aRow, pattern: aPat });
          if (!nTs.has(aRow)) nTs.set(aRow, fmtTs(tn.entry.responseTs));   // don't double-stamp a shared row
        }
      }
    }

    applyDiff(nTags, nTurn, nStart, nEnd, nTs);
    diag('mcc-turns', { markers: markers.length, turns: turns.length, confirmed: confirmed, stamped: nTs.size });
  }

  function setAttr(el, name, val) {
    if (val == null) { if (el.hasAttribute(name)) el.removeAttribute(name); return; }
    if (el.getAttribute(name) !== val) el.setAttribute(name, val);
  }
  function applyDiff(nTags, nTurn, nStart, nEnd, nTs) {
    // roles / turn id
    curTags.forEach(function (_v, el) { if (!nTags.has(el)) { el.removeAttribute('data-mcc-role'); el.removeAttribute('data-mcc-turn'); } });
    nTags.forEach(function (role, el) { setAttr(el, 'data-mcc-role', role); setAttr(el, 'data-mcc-turn', nTurn.get(el)); });
    // start / end classes
    curStart.forEach(function (el) { if (!nStart.has(el)) el.classList.remove('mcc-turn-start'); });
    nStart.forEach(function (el) { el.classList.add('mcc-turn-start'); });
    curEnd.forEach(function (el) { if (!nEnd.has(el)) el.classList.remove('mcc-turn-end'); });
    nEnd.forEach(function (el) { el.classList.add('mcc-turn-end'); });
    // timestamps
    curTs.forEach(function (_ts, el) { if (!nTs.has(el)) el.removeAttribute('data-mcc-ts'); });
    nTs.forEach(function (ts, el) { setAttr(el, 'data-mcc-ts', ts); });
    curTags = nTags; curTurn = nTurn; curStart = nStart; curEnd = nEnd; curTs = nTs;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // ISO datetime in LOCAL time, without the 'T' separator: "YYYY-MM-DD HH:MM:SS".
  function fmtTs(iso) {
    var d = new Date(iso);
    if (isNaN(+d)) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
           pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // ---- settings toggle --------------------------------------------------
  tv.contributes.settingsTab({
    id: 'mobile-cc-turns',
    title: 'Message Regions',
    render: function (container) {
      var wrap = document.createElement('div');
      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:13px;line-height:1.5;margin:0 0 14px;';
      intro.textContent = 'Overlay message structure on the terminal: tint user vs assistant turns, draw a separator between turns, and show when you sent each prompt. Matched against the Claude Code transcript; unmatched output stays plain.';
      wrap.appendChild(intro);

      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:14px;color:var(--ttv-fg);cursor:pointer;';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = enabled();
      cb.style.cssText = 'width:20px;height:20px;';
      var lbl = document.createElement('span');
      lbl.textContent = 'Show message regions in the terminal';
      cb.addEventListener('change', function () {
        SELF.set('enabled', cb.checked);
        if (cb.checked) { injectStyle(); scheduleCorrelate(); }
        else { clearAll(); }
      });
      row.appendChild(cb); row.appendChild(lbl);
      wrap.appendChild(row);
      container.appendChild(wrap);
    },
  });

  // ---- wiring -----------------------------------------------------------
  var t = null;
  function scheduleCorrelate() { if (t) clearTimeout(t); t = setTimeout(correlate, 250); }

  function wire() {
    var host = document.getElementById('grid-host');
    if (!host) return false;
    new MutationObserver(function () { if (enabled()) scheduleCorrelate(); })
      .observe(host, { childList: true, subtree: true, characterData: true });
    return true;
  }

  injectStyle();
  var tries = 0;
  var iv = setInterval(function () { if (wire() || ++tries > 60) { clearInterval(iv); scheduleCorrelate(); } }, 250);
  if (wire()) { clearInterval(iv); scheduleCorrelate(); }

  try { tv.on('grid-loaded', function () { scheduleCorrelate(); }); } catch (e) {}
  try { tv.on('scrollback-prefill', function () { scheduleCorrelate(); }); } catch (e) {}
  try { tv.on('pane-changed', function () { tc = null; clearAll(); setTimeout(scheduleCorrelate, 60); }); } catch (e) {}
  window.addEventListener('resize', function () { if (enabled()) scheduleCorrelate(); });
  diag('mcc-turns-init', { enabled: enabled() });
})();
