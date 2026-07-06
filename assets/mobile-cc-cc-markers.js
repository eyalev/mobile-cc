// mobile-cc-cc-markers — shared CC-prompt/marker scanner for the cell-grid.
//
// ONE module, multiple consumers (mobile-cc-prompt-nav = ▲/▼ nav over user
// prompts; mobile-cc-turns = JSONL↔row correlation / message regions). Both
// need the same truth: where are CC's per-message marker rows, and where does
// the bottom "chrome" (input box + status) begin so we never treat the live
// input as a submitted prompt.
//
// CC's TUI marks the first cell of a row: '❯' (or older '>') = a submitted
// USER prompt; '●' = an ASSISTANT message / tool call. The bottom input box
// also uses '❯' but sits below a '────' rule / a '✻ … for Ns' status / the
// '⏵⏵ …' line — detectChromeStart() finds that boundary so consumers clamp to
// it. Exposed as window.mccMarkers; resolve it at CALL time (load-order safe).
(function () {
  if (window.mccMarkers) return;

  var USER_MARKERS = ['❯', '>'];

  function firstGlyph(text) {
    var i = 0;
    while (i < text.length && text[i] === ' ') i++;
    return { idx: i, ch: text[i] || '' };
  }
  function isRule(t) {
    t = t.trim();
    return t.length >= 6 && /^[─━┄┅┈┉—–_-]{6,}$/.test(t);
  }
  function isStatus(t) {
    return /⏵⏵|bypass permissions|\? for shortcuts|for agents|esc to interrupt/i.test(t);
  }
  function roleFor(ch) {
    if (ch === '❯' || ch === '>') return 'user';
    if (ch === '●') return 'assistant';
    return null;
  }

  // Index where CC's bottom chrome (input box + dividers + status) starts —
  // blocks clamp here so the live input '❯' is never a submitted prompt. We
  // anchor on a divider/status row in the last ~8 DOM rows, then walk UP over
  // the CONTIGUOUS chrome run (dividers, status, the input '❯', blank rows) to
  // its top. A mid-transcript "✻ … for Ns" turn-completion is NOT chrome (it's
  // the end of an assistant region) and is correctly excluded — only the
  // bottom contiguous run counts, regardless of transcript length or scroll.
  function detectChromeStart(rows) {
    var n = rows.length;
    var anchor = -1;
    for (var k = n - 1; k >= Math.max(0, n - 8); k--) {
      var t = rows[k].textContent || '';
      if (isRule(t) || isStatus(t)) { anchor = k; break; }
    }
    if (anchor < 0) return n;                   // no bottom chrome → no clamp
    var start = anchor;
    for (var j = anchor - 1; j >= 0; j--) {
      var tj = rows[j].textContent || '';
      var g = firstGlyph(tj);
      var isInputMarker = g.idx <= 1 && (g.ch === '❯' || g.ch === '>');
      if (isRule(tj) || isStatus(tj) || isInputMarker || tj.trim() === '') start = j;
      else break;
    }
    return start;
  }

  // Scan a host's .ttv-row elements into ordered marker entries (top→bottom =
  // oldest→newest), excluding the chrome region, deduping adjacent identical
  // rows (CC SIGWINCH re-emit duplicates).
  function scan(host) {
    var live = host ? host.getElementsByClassName('ttv-row') : [];
    var rows = [];
    for (var i = 0; i < live.length; i++) rows.push(live[i]);
    var chromeStart = detectChromeStart(rows);
    var markers = [], prevKey = null;
    for (var j = 0; j < rows.length && j < chromeStart; j++) {
      var txt = rows[j].textContent || '';
      var g = firstGlyph(txt);
      if (g.idx > 1) continue;
      var role = roleFor(g.ch);
      if (!role) continue;
      var after = txt[g.idx + 1];
      if (after !== ' ' && after !== undefined) continue;
      var post = txt.slice(g.idx + 1).trim();
      var key = role + '|' + post;
      if (prevKey === key) continue;            // adjacent dup → drop
      prevKey = key;
      markers.push({ idx: j, el: rows[j], ch: g.ch, role: role, post: post });
    }
    return { rows: rows, chromeStart: chromeStart, markers: markers };
  }

  function userMarkers(host) {
    return scan(host).markers.filter(function (m) { return m.role === 'user'; });
  }

  window.mccMarkers = {
    USER_MARKERS: USER_MARKERS,
    scan: scan,
    userMarkers: userMarkers,
    detectChromeStart: detectChromeStart,
  };
})();
