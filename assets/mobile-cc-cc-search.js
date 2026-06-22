// mobile-cc-cc-search — find which tab/session you worked on, from the phone.
//
// A 🔍 header button opens a full-screen search overlay. Two lanes run in
// parallel:
//   • Lane A (instant): debounced GET /api/cc-search?q= → ranked CC sessions
//     with context (the matching prompt). Fully local (ripgrep server-side).
//   • Lane B (AI pick): on a typing pause, reranks Lane A's candidates with
//     Groq (llama-3.3-70b) and surfaces a single "✨ AI pick" + one-line why.
//     Opt-in (Settings → Session Search); reuses the ttyview-stt-groq key.
//     Sends query + snippets to an external API, so it's off by default.
//
// Result actions: open tab → jump (tv.selectPane); closed session →
// preview transcript (/api/cc-session/:id) or reopen in that cwd
// (POST /api/sessions). Design notes: .claude/cc-search.md.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-cc-search] requires apiVersion 1');
    return;
  }

  var STORAGE = tv.storage('mobile-cc-cc-search');
  var GROQ_BASE = 'https://api.groq.com/openai/v1';
  var GROQ_MODEL = 'llama-3.3-70b-versatile';
  var ACCENT = 'var(--ttv-rail-accent, #E8896B)';

  function aiEnabled() { return STORAGE.get('aiEnabled') === true; }
  function groqKey() {
    try {
      var s = tv.storage('ttyview-stt-groq').get('settings');
      return (s && s.groqKey) || '';
    } catch (e) { return ''; }
  }

  // ---- overlay state ----------------------------------------------------
  var overlay = null, input = null, resultsEl = null, aiBox = null, statusEl = null;
  var kwTimer = null, aiTimer = null;
  var kwSeq = 0, aiSeq = 0;
  var lastResults = [];
  var lastResultsQ = '';      // the query lastResults belongs to (couples lane B to lane A)
  var sortMode = STORAGE.get('sortMode') === 'recent' ? 'recent' : 'relevance';
  var sortRow = null;

  // Client-side re-sort of the daemon's results (the daemon returns them
  // relevance-sorted; this also powers the "Most recent" toggle without a
  // refetch).
  function applySort(list) {
    var arr = list.slice();
    if (sortMode === 'recent') {
      arr.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    } else {
      arr.sort(function (a, b) {
        return (b.score - a.score) || (b.date || '').localeCompare(a.date || '');
      });
    }
    return arr;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function tokens(q) {
    return (q.toLowerCase().match(/[a-z0-9]+/g) || []).filter(function (t) { return t.length >= 2; });
  }
  function highlight(text, q) {
    var html = esc(text);
    tokens(q).forEach(function (t) {
      var re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      html = html.replace(re, '$1');
    });
    return html.replace(//g, '<mark style="background:' + ACCENT + ';color:#1b1b1b;border-radius:2px;">')
               .replace(//g, '</mark>');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
  }

  // ---- rendering --------------------------------------------------------
  function resultRow(r, q, relPct) {
    var row = document.createElement('div');
    row.style.cssText =
      'padding:10px 12px;border-bottom:1px solid var(--ttv-border,#2a2a2a);cursor:pointer;';
    var badge = r.open
      ? '<span style="color:#3ddc84;font-size:11px;font-weight:700;">● open</span>'
      : '<span style="color:var(--ttv-muted,#888);font-size:11px;">closed</span>';
    // Whose message the snippet matched — your prompt vs Claude's reply.
    var isMine = r.role === 'user';
    var speaker = isMine
      ? '<span style="color:' + ACCENT + ';font-weight:700;">You:</span> '
      : '<span style="color:#7fb2ff;font-weight:700;">Claude:</span> ';
    // When sorting by recency, accent the date so the sort key is obvious.
    var recent = sortMode === 'recent';
    var dateStyle = recent
      ? 'flex:none;color:' + ACCENT + ';font-size:11px;font-weight:700;'
      : 'flex:none;color:var(--ttv-muted,#888);font-size:11px;';
    row.innerHTML =
      '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;">' +
        '<div style="font-weight:700;color:var(--ttv-fg,#eee);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          esc(r.label) + '</div>' +
        '<div style="' + dateStyle + '">' + esc(fmtDate(r.date)) + '</div>' +
      '</div>' +
      '<div style="margin-top:3px;font-size:12px;color:var(--ttv-fg,#ccc);line-height:1.35;' +
        'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">' +
        speaker + highlight(r.snippet, q) + '</div>' +
      '<div style="margin-top:4px;display:flex;gap:10px;align-items:center;font-size:11px;color:var(--ttv-muted,#888);">' +
        badge +
        '<span>' + r.match_count + ' match' + (r.match_count === 1 ? '' : 'es') + '</span>' +
        '<span title="relevance">' + relPct + '% rel</span>' +
        (r.open ? '' : '<span style="margin-left:auto;color:' + ACCENT + ';">Preview · Reopen ▾</span>') +
      '</div>' +
      // Relevance meter — the bar that makes the ranking legible. Dimmed
      // when sorting by recency (relevance isn't the sort key then).
      '<div style="margin-top:5px;height:3px;border-radius:2px;background:var(--ttv-border,#333);">' +
        '<div style="height:100%;width:' + relPct + '%;border-radius:2px;background:' + ACCENT + ';' +
        (recent ? 'opacity:.4;' : '') + '"></div>' +
      '</div>';
    row.addEventListener('click', function () {
      if (r.open) jumpTo(r);
      else preview(r);
    });
    return row;
  }

  function renderResults(list, q) {
    if (!resultsEl) return;
    resultsEl.innerHTML = '';
    styleSortChips();
    if (!list.length) {
      statusEl.textContent = q ? 'No matches.' : '';
      return;
    }
    statusEl.textContent = list.length + ' session' + (list.length === 1 ? '' : 's');
    var sorted = applySort(list);
    var maxScore = sorted.reduce(function (m, r) { return Math.max(m, r.score || 0); }, 0.0001);
    sorted.forEach(function (r) {
      var pct = Math.max(6, Math.round(((r.score || 0) / maxScore) * 100));
      resultsEl.appendChild(resultRow(r, q, pct));
    });
  }

  // ---- sort toggle (Relevance / Most recent) ----------------------------
  function buildSortRow() {
    sortRow = document.createElement('div');
    sortRow.style.cssText =
      'display:flex;gap:8px;align-items:center;padding:2px 12px 8px;flex-wrap:wrap;';
    var lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:11px;color:var(--ttv-muted,#888);';
    lbl.textContent = 'Sort:';
    sortRow.appendChild(lbl);
    [['relevance', 'Relevance'], ['recent', 'Most recent']].forEach(function (m) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.mode = m[0];
      chip.textContent = m[1];
      chip.onclick = function () {
        if (sortMode === m[0]) return;
        sortMode = m[0];
        STORAGE.set('sortMode', sortMode);
        renderResults(lastResults, input ? input.value.trim() : '');
      };
      sortRow.appendChild(chip);
    });
    var legend = document.createElement('span');
    legend.className = 'mcc-sort-legend';
    legend.style.cssText = 'font-size:11px;color:var(--ttv-muted,#777);margin-left:auto;';
    sortRow.appendChild(legend);
    styleSortChips();
  }
  function styleSortChips() {
    if (!sortRow) return;
    Array.prototype.forEach.call(sortRow.querySelectorAll('button'), function (chip) {
      var on = chip.dataset.mode === sortMode;
      chip.style.cssText =
        'cursor:pointer;border-radius:999px;padding:3px 11px;font-size:12px;font-family:inherit;' +
        'border:1px solid ' + ACCENT + ';' +
        (on ? 'background:' + ACCENT + ';color:#1b1b1b;font-weight:700;'
            : 'background:transparent;color:' + ACCENT + ';');
    });
    var legend = sortRow.querySelector('.mcc-sort-legend');
    if (legend) {
      legend.textContent = sortMode === 'recent'
        ? 'newest first'
        : 'best match · your prompts · recency';
    }
  }

  // ---- lane A: keyword search ------------------------------------------
  function doKeywordSearch(q) {
    var seq = ++kwSeq;
    fetch('/api/cc-search?q=' + encodeURIComponent(q) + '&limit=20')
      // A non-2xx response is an error, NOT "zero matches" — surface it so a
      // backend failure (ripgrep missing, perms) doesn't masquerade as an
      // empty result set.
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (list) {
        if (seq !== kwSeq) return;            // stale
        lastResults = list;
        lastResultsQ = q;
        renderResults(list, q);
        scheduleAi(q);                        // arm lane B against THIS query's results
      })
      .catch(function () { if (seq === kwSeq && statusEl) statusEl.textContent = 'Search error.'; });
  }

  // Lane B is armed from lane A's success handler (not an independent timer) so
  // the AI pick can only ever rerank candidates that belong to the current
  // query — never a previous query's results that are still in lastResults.
  function scheduleAi(q) {
    clearTimeout(aiTimer);
    aiTimer = setTimeout(function () { doAiPick(q); }, 450);
  }

  // ---- lane B: Groq AI pick --------------------------------------------
  function renderAiBox(state, payload) {
    if (!aiBox) return;
    if (state === 'hidden') { aiBox.style.display = 'none'; aiBox.innerHTML = ''; return; }
    aiBox.style.display = 'block';
    if (state === 'thinking') {
      aiBox.innerHTML = '<span style="opacity:.7;">✨ AI is picking the best match…</span>';
      return;
    }
    if (state === 'pick' && payload) {
      aiBox.innerHTML =
        '<div style="font-size:11px;color:#1b1b1b;opacity:.8;font-weight:700;">✨ AI PICK</div>' +
        '<div style="font-weight:700;margin-top:2px;">' + esc(payload.label) + '</div>' +
        '<div style="font-size:12px;margin-top:2px;line-height:1.35;">' + esc(payload.reason) + '</div>';
      aiBox.onclick = function () {
        if (payload.result.open) jumpTo(payload.result); else preview(payload.result);
      };
    }
  }

  function doAiPick(q) {
    if (!aiEnabled()) { renderAiBox('hidden'); return; }
    var key = groqKey();
    if (!key) { renderAiBox('hidden'); return; }
    if (lastResultsQ !== q) return;          // results aren't for this query (yet)
    var cands = lastResults.slice(0, 12);
    if (!cands.length) { renderAiBox('hidden'); return; }
    var seq = ++aiSeq;
    renderAiBox('thinking');

    var list = cands.map(function (r, i) {
      return { n: i, id: r.session_id, label: r.label, date: r.date, open: r.open, snippet: (r.snippet || '').slice(0, 240) };
    });
    var sys = 'You help a developer find which past coding session matches their query. ' +
      'Given the query and candidate sessions (each with a label, date, and a snippet of its content), ' +
      'pick the SINGLE most relevant session. Reply with strict JSON: {"n": <candidate number>, "reason": "<one short sentence why>"}. ' +
      'No prose outside the JSON.';
    var usr = 'Query: ' + q + '\n\nCandidates:\n' + JSON.stringify(list, null, 0);

    fetch(GROQ_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (seq !== aiSeq) return;            // stale
        var txt = data && data.choices && data.choices[0] && data.choices[0].message.content;
        if (!txt) { renderAiBox('hidden'); return; }
        var obj; try { obj = JSON.parse(txt); } catch (e) { renderAiBox('hidden'); return; }
        var idx = typeof obj.n === 'number' ? obj.n : -1;
        var r = cands[idx];
        if (!r) { renderAiBox('hidden'); return; }
        if (typeof window.ttviewLog === 'function') window.ttviewLog('cc-search-ai', { q: q, pick: r.label });
        renderAiBox('pick', { label: r.label, reason: obj.reason || 'Best match for your query.', result: r });
      })
      .catch(function () { if (seq === aiSeq) renderAiBox('hidden'); });
  }

  // ---- input handling ---------------------------------------------------
  function onInput() {
    var q = input.value.trim();
    renderAiBox('hidden');
    clearTimeout(kwTimer); clearTimeout(aiTimer);
    if (!q) { lastResults = []; lastResultsQ = ''; renderResults([], ''); return; }
    statusEl.textContent = 'Searching…';
    // Lane A runs first; lane B (AI pick) is armed from lane A's success
    // handler (scheduleAi) so it only reranks results for THIS query.
    kwTimer = setTimeout(function () { doKeywordSearch(q); }, 150);
  }

  // ---- actions ----------------------------------------------------------
  function jumpTo(r) {
    var panes = (tv.listPanes && tv.listPanes()) || [];
    var hit = panes.filter(function (p) { return p.id === r.pane_id; })[0]
           || panes.filter(function (p) { return p.session === r.tmux_name; })[0];
    if (hit) { tv.selectPane(hit.id); closeOverlay(); }
    else if (tv.toast) tv.toast('That tab is no longer open.');
  }

  function reopen(r) {
    var name = (r.cwd.split('/').pop() || 'session');
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, cwd: r.cwd }),
    })
      .then(function (resp) { return resp.json().catch(function () { return {}; }); })
      .then(function () {
        if (tv.refreshPanes) tv.refreshPanes();
        if (tv.toast) tv.toast('Opened tab "' + name + '" in ' + r.cwd + ' — tap ▶ cc to continue.');
        closeOverlay();
      })
      .catch(function () { if (tv.toast) tv.toast('Could not reopen that session.'); });
  }

  function preview(r) {
    var seq = kwSeq;                          // closeOverlay() bumps kwSeq → invalidates this load
    resultsEl.innerHTML = '';
    aiBox.style.display = 'none';
    statusEl.textContent = 'Loading transcript…';

    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;padding:8px 12px;align-items:center;border-bottom:1px solid var(--ttv-border,#2a2a2a);';
    var back = document.createElement('button');
    back.type = 'button'; back.textContent = '‹ Back';
    back.style.cssText = 'background:transparent;border:1px solid var(--ttv-border,#3a3a3a);color:var(--ttv-fg,#eee);border-radius:6px;padding:5px 10px;cursor:pointer;';
    back.onclick = function () { renderResults(lastResults, input.value.trim()); };
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    title.textContent = r.label;
    var reBtn = document.createElement('button');
    reBtn.type = 'button'; reBtn.textContent = '↻ Reopen';
    reBtn.style.cssText = 'background:transparent;border:1px solid ' + ACCENT + ';color:' + ACCENT + ';border-radius:6px;padding:5px 10px;cursor:pointer;white-space:nowrap;';
    reBtn.onclick = function () { reopen(r); };
    bar.appendChild(back); bar.appendChild(title);
    if (!r.open) bar.appendChild(reBtn);
    resultsEl.appendChild(bar);

    var body = document.createElement('div');
    body.style.cssText = 'padding:8px 12px;';
    resultsEl.appendChild(body);

    fetch('/api/cc-session/' + encodeURIComponent(r.session_id))
      .then(function (resp) { return resp.ok ? resp.json() : []; })
      .then(function (msgs) {
        if (seq !== kwSeq || !statusEl) return;   // overlay closed mid-load
        statusEl.textContent = msgs.length + ' messages';
        var q = input.value.trim();
        body.innerHTML = msgs.map(function (m) {
          var who = m.role === 'user' ? 'You' : 'Claude';
          var col = m.role === 'user' ? ACCENT : 'var(--ttv-muted,#9aa)';
          return '<div style="margin:10px 0;">' +
            '<div style="font-size:11px;font-weight:700;color:' + col + ';">' + who +
            ' <span style="color:var(--ttv-muted,#777);font-weight:400;">' + esc(fmtDate(m.ts)) + '</span></div>' +
            '<div style="font-size:12px;line-height:1.4;color:var(--ttv-fg,#ddd);white-space:pre-wrap;word-break:break-word;">' +
            highlight((m.text || '').slice(0, 4000), q) + '</div></div>';
        }).join('');
      })
      .catch(function () { if (seq === kwSeq && statusEl) statusEl.textContent = 'Could not load transcript.'; });
  }

  // ---- overlay open/close ----------------------------------------------
  function openOverlay() {
    if (overlay) { input.focus(); return; }
    overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:var(--ttv-bg,#111);' +
      'display:flex;flex-direction:column;';

    var top = document.createElement('div');
    top.style.cssText = 'display:flex;gap:8px;padding:10px 12px;align-items:center;border-bottom:1px solid var(--ttv-border,#2a2a2a);';
    input = document.createElement('input');
    input.type = 'search'; input.placeholder = 'Search your sessions…';
    input.autocapitalize = 'off'; input.autocomplete = 'off'; input.spellcheck = false;
    input.style.cssText =
      'flex:1;min-width:0;padding:9px 12px;border:1px solid var(--ttv-border,#3a3a3a);' +
      'border-radius:8px;background:var(--ttv-bg-elev2,#1c1c1c);color:var(--ttv-fg,#eee);' +
      'font-size:15px;font-family:inherit;';
    input.addEventListener('input', onInput);
    // Visible AI-pick toggle (filled coral = on). Auto-fires on a typing
    // pause when on; tapping with a query already typed runs it now.
    var aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    function styleAiBtn() {
      var on = aiEnabled();
      aiBtn.textContent = '✨ AI';
      aiBtn.title = on ? 'AI pick: on — tap to turn off' : 'AI pick: off — tap to turn on';
      aiBtn.style.cssText =
        'flex:none;cursor:pointer;border-radius:8px;padding:8px 11px;font-size:13px;' +
        'font-weight:700;font-family:inherit;white-space:nowrap;border:1px solid ' + ACCENT + ';' +
        (on ? 'background:' + ACCENT + ';color:#1b1b1b;' : 'background:transparent;color:' + ACCENT + ';');
    }
    styleAiBtn();
    aiBtn.onclick = function () {
      if (!groqKey()) {
        if (tv.toast) tv.toast('Add a Groq key in Settings → Voice Input to use AI pick.');
        return;
      }
      STORAGE.set('aiEnabled', !aiEnabled());
      styleAiBtn();
      var q = input.value.trim();
      if (aiEnabled() && q) doAiPick(q);
      else renderAiBox('hidden');
    };

    var close = document.createElement('button');
    close.type = 'button'; close.textContent = '✕';
    close.style.cssText = 'flex:none;background:transparent;border:none;color:var(--ttv-fg,#eee);font-size:20px;cursor:pointer;padding:4px 8px;';
    close.onclick = closeOverlay;
    top.appendChild(input); top.appendChild(aiBtn); top.appendChild(close);

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'padding:4px 12px;font-size:11px;color:var(--ttv-muted,#888);';

    aiBox = document.createElement('div');
    aiBox.style.cssText =
      'display:none;margin:6px 12px;padding:10px 12px;border-radius:10px;cursor:pointer;' +
      'background:' + ACCENT + ';color:#1b1b1b;';

    resultsEl = document.createElement('div');
    resultsEl.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;';

    buildSortRow();

    overlay.appendChild(top);
    overlay.appendChild(statusEl);
    overlay.appendChild(sortRow);
    overlay.appendChild(aiBox);
    overlay.appendChild(resultsEl);
    document.body.appendChild(overlay);
    setTimeout(function () { input.focus(); }, 30);
  }

  function closeOverlay() {
    clearTimeout(kwTimer); clearTimeout(aiTimer);
    kwSeq++; aiSeq++;
    if (overlay) { overlay.remove(); overlay = null; input = resultsEl = aiBox = statusEl = sortRow = null; }
  }

  // ---- contributions ----------------------------------------------------
  tv.contributes.headerWidget({
    id: 'mobile-cc-cc-search',
    name: 'Session search',
    preferredSlot: 'header-right',
    render: function (slot) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.title = 'Search your sessions';
      // Inline SVG magnifier (stroke = currentColor) so it matches the
      // app's other header icons / theme instead of an emoji glyph. Keep
      // the default header-button box (bg/border/padding from core CSS) —
      // only `cursor` is overridden, exactly like the other header widgets.
      btn.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true" focusable="false" ' +
        'style="display:inline-block;vertical-align:middle;">' +
        '<circle cx="10.5" cy="10.5" r="6.5"></circle>' +
        '<line x1="20" y1="20" x2="15.5" y2="15.5"></line></svg>';
      btn.style.cssText = 'cursor:pointer;';
      btn.addEventListener('click', openOverlay);
      slot.appendChild(btn);
      return function unmount() { closeOverlay(); btn.remove(); };
    },
  });

  tv.contributes.settingsTab({
    id: 'mobile-cc-cc-search',
    title: 'Session Search',
    render: function (container) {
      container.innerHTML = '';
      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 12px;line-height:1.5;';
      intro.innerHTML =
        'The 🔍 button in the header searches all your Claude Code sessions ' +
        '(<code>~/.claude/projects</code>) and ranks the tabs/sessions most ' +
        'relevant to your query. Keyword search is 100% local.';
      container.appendChild(intro);

      var label = document.createElement('label');
      label.style.cssText = 'display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--ttv-fg);cursor:pointer;';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = aiEnabled();
      cb.style.cssText = 'margin-top:2px;';
      cb.addEventListener('change', function () { STORAGE.set('aiEnabled', cb.checked); });
      var txt = document.createElement('div');
      var hasKey = !!groqKey();
      txt.innerHTML =
        '<b>AI pick (Groq)</b> — recommend the single best session.' +
        '<div style="color:var(--ttv-muted);font-size:12px;margin-top:3px;line-height:1.5;">' +
        'Reranks results with llama-3.3-70b on a typing pause. <b>Sends your query + ' +
        'snippets to Groq</b>, so it\'s off by default. Reuses your Voice Input Groq key' +
        (hasKey ? '.' : ' — <span style="color:' + ACCENT + ';">no key set yet (Settings → Voice Input).</span>') +
        '</div>';
      label.appendChild(cb); label.appendChild(txt);
      container.appendChild(label);
    },
  });
})();
