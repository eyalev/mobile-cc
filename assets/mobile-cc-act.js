// mobile-cc-act — natural-language command router ("Ask AI…").
//
// The AI half of the act-bar. You type/speak a request; a fast model maps it to
// EXACTLY ONE registered command (or proposes a plan / asks to clarify), and you
// confirm before it runs. Browser-direct to Groq's OpenAI-compatible API — same
// pattern + same BYO key as the STT cleanup (ttyview-stt-groq); Groq is CORS-open
// so no daemon endpoint is needed. The command registry IS the tool surface, so
// any command (esp. args-bearing ones, via the palette's arg-form contract) is
// automatically AI-drivable.
//
// Entry point is itself a palette command — "Ask AI…" with a single text arg —
// so it rides the arg-form support with zero new UI plumbing.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    if (tv && tv.apiVersion !== 1) console.warn('[mobile-cc-act] requires apiVersion 1');
    return;
  }

  // Any OpenAI-compatible chat-completions provider works (same wire format).
  var PROVIDERS = {
    groq:   { label: 'Groq',   base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1',      model: 'gpt-4o-mini' },
    custom: { label: 'Custom (base URL)', base: '',                    model: '' },
  };
  var STORE = tv.storage('mobile-cc-act');

  function loadSettings() {
    var s = {};
    try { s = STORE.get('settings') || {}; } catch (e) {}
    var provider = PROVIDERS[s.provider] ? s.provider : 'groq';
    var prov = PROVIDERS[provider];
    return {
      provider: provider,
      key: s.key || s.groqKey || '',                                  // back-compat: old field was groqKey
      model: s.model || prov.model,
      baseUrl: provider === 'custom' ? (s.baseUrl || '') : prov.base,
      autoRun: !!s.autoRun,                                           // execute safe actions without a confirm card
    };
  }
  // Use Ask AI's own key; only Groq may borrow the STT key (same provider).
  function apiKey() {
    var s = loadSettings();
    if (s.key) return s.key;
    if (s.provider === 'groq') {
      try { return (tv.storage('ttyview-stt-groq').get('settings') || {}).groqKey || ''; } catch (e) {}
    }
    return '';
  }
  function esc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
  function liveSessions() {
    var panes = (tv.listPanes && tv.listPanes()) || [], seen = {}, out = [];
    panes.forEach(function (p) { if (p.session && !seen[p.session]) { seen[p.session] = 1; out.push({ session: p.session, id: p.id }); } });
    return out;
  }

  // ---- registry → OpenAI tool defs ------------------------------------
  function argsToSchema(args) {
    var props = {}, required = [];
    (args || []).forEach(function (a) {
      var p;
      if (a.type === 'number') { p = { type: 'number' }; if (a.min != null) p.minimum = a.min; if (a.max != null) p.maximum = a.max; }
      else if (a.type === 'enum') { p = { type: (typeof (a.options || [])[0] === 'number') ? 'number' : 'string', enum: a.options || [] }; }
      else if (a.type === 'bool') { p = { type: 'boolean' }; }
      else { p = { type: 'string' }; }                       // string | text | session | pane
      var d = a.describe || '';
      if (a.type === 'session' || a.type === 'pane') d = (d ? d + '. ' : '') + 'Pass the pane id (the %N value) of the chosen session.';
      if (d) p.description = d;
      props[a.name] = p;
      if (a.required) required.push(a.name);
    });
    return { type: 'object', properties: props, required: required };
  }
  var SAN = function (id) { return id.replace(/\./g, '__'); };          // dots are illegal in OpenAI fn names
  var UNSAN = function (n) { return n.replace(/__/g, '.'); };

  function buildTools() {
    var tools = [];
    [...tv._internal.registries.command.values()].forEach(function (c) {
      // Skip the dynamic switcher/chip floods + self; expose the rest (incl.
      // zero-arg commands as empty-param tools so "make text bigger" routes).
      if (c.id.indexOf('mcc.goto.') === 0 || c.id.indexOf('mcc.run.') === 0 || c.id === 'mcc.ai') return;
      tools.push({ type: 'function', function: {
        name: SAN(c.id),
        description: (c.name || c.id) + (c.keywords && c.keywords.length ? ' — ' + c.keywords.join(', ') : ''),
        parameters: c.args && c.args.length ? argsToSchema(c.args) : { type: 'object', properties: {} },
      } });
    });
    // synthetic switcher — collapses the ~70 per-session "Go to" commands into one
    var sess = liveSessions();
    if (sess.length) {
      tools.push({ type: 'function', function: {
        name: 'go_to_session',
        description: 'Switch the view to a session.',
        parameters: { type: 'object', properties: { session: { type: 'string', enum: sess.map(function (s) { return s.session; }) } }, required: ['session'] },
      } });
    }
    // meta-tools (always present)
    tools.push({ type: 'function', function: { name: 'propose_plan',
      description: 'Use when the request is multi-step coding/agent WORK that does not map to a single app command. Provide concrete steps.',
      parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } } });
    tools.push({ type: 'function', function: { name: 'clarify',
      description: 'Use when the request is ambiguous and you need one short question answered before acting.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } });
    return tools;
  }

  var SYS =
    'You are the command router for mobile-cc, a phone UI for driving tmux / Claude Code sessions. ' +
    'Map the user request to EXACTLY ONE tool call. Prefer a concrete app-control tool when the request matches one ' +
    '(change a setting, switch sessions, send text to a session). For a session/pane argument, choose from the live ' +
    'sessions listed and pass that session\'s pane id (the %N value). If the request is coding/agent WORK that does not ' +
    'map to one app tool, call propose_plan with concrete steps. If it is ambiguous, call clarify with one short question. ' +
    'Always call exactly one tool.';

  // ---- logging → <config_dir>/diag.jsonl via ttvDiag (cat 'act'/'palette') -
  // Builds the interaction dataset: every Ctrl-K open / command pick / AI
  // request→response→dispatch→result. Filter with: jq 'select(.cat=="act" or .cat=="palette")'
  var ACT_SEQ = 0;
  function logAct(ev, rec) { try { window.ttvDiag && window.ttvDiag('act', Object.assign({ ev: ev }, rec)); } catch (e) {} }
  function logPal(ev, rec) { try { window.ttvDiag && window.ttvDiag('palette', Object.assign({ ev: ev }, rec)); } catch (e) {} }

  // Sentence-like → the Ask AI row pre-selects (Enter fires it) instead of a
  // command. Heuristic, deliberately simple; the interaction log tells us when
  // it mis-ranks so we can tune it.
  var VERBS = /^(send|tell|ask|go|switch|set|make|run|open|create|show|change|move|find|delegate|put|give)\b/i;
  function sentenceLike(q) {
    if (q.indexOf(' ') < 0) return false;
    return q.split(/\s+/).length >= 4 || /['"]/.test(q) || VERBS.test(q);
  }

  // ---- history: recent AI queries + command runs, for fast re-choosing -
  // Recorded on every real AI query (runAct) and command execution
  // (command-run). Surfaced as palette rows: recents on top when the input is
  // empty (Ctrl-K → arrow through, or Enter to repeat the last), matches while
  // you type. Server-synced, capped, deduped most-recent-first.
  var HIST = tv.storage('mobile-cc-history');
  var HIST_MAX = 50;
  function histLoad() { try { return HIST.get('items') || []; } catch (e) { return []; } }
  function histKey(e) { return e.kind === 'ai' ? 'ai|' + e.text : 'cmd|' + e.id + '|' + JSON.stringify(e.args || {}); }
  function histPush(entry) {
    var k = histKey(entry);
    var items = histLoad().filter(function (x) { return histKey(x) !== k; });
    items.unshift(entry);
    if (items.length > HIST_MAX) items = items.slice(0, HIST_MAX);
    try { HIST.set('items', items); } catch (e) {}
  }
  function histLabel(e) {
    if (e.kind === 'ai') return '↻ ' + e.text;
    var def = tv._internal.registries.command.get(e.id);
    var nm = (def && def.name) || e.id;
    var a = e.args && Object.keys(e.args).length ? ' (' + Object.keys(e.args).map(function (k) { return e.args[k]; }).join(', ') + ')' : '';
    return '↻ ' + nm + a;
  }
  function histText(e) { return e.kind === 'ai' ? e.text : histLabel(e); }
  function histReplay(e) {
    logPal('history-replay', { kind: e.kind, id: e.id });
    if (e.kind === 'ai') { runAct(e.text, 'history'); return; }
    var def = tv._internal.registries.command.get(e.id);
    if (!def) { showCard('That command no longer exists.'); return; }
    if (def.danger) { confirmRun(def, e.args || {}, { seq: 0, id: def.id }); return; }
    try { execDef(def, e.args || {}); tv.toast && tv.toast('↻ ' + (def.name || def.id)); }
    catch (err) { showCard('Failed: ' + esc(err && err.message || err)); }
  }

  // ---- the call --------------------------------------------------------
  async function runAct(text, source) {
    var seq = ++ACT_SEQ;
    var cfg = loadSettings();
    var key = apiKey();
    if (!key) { showCard('<b>No API key set.</b><br>Add one in Settings → Ask AI.'); return; }
    if (!cfg.baseUrl) { showCard('<b>No API base URL.</b><br>Pick a provider in Settings → Ask AI.'); return; }
    if (source !== 'history' && source !== 'clarify') histPush({ kind: 'ai', text: text });
    showCard('<span style="opacity:.7">…thinking</span>');
    var sess = liveSessions();
    var ctx = sess.length ? sess.map(function (s) { return '- ' + s.session + ' (pane ' + s.id + ')'; }).join('\n') : '(none)';
    var tools = buildTools();
    logAct('request', { seq: seq, q: text, source: source || 'cmd', provider: cfg.provider, model: cfg.model, tools: tools.length });
    var body = {
      model: cfg.model, temperature: 0, tool_choice: 'required', tools: tools,
      messages: [
        { role: 'system', content: SYS + '\n\nLive sessions:\n' + ctx },
        { role: 'user', content: text },
      ],
    };
    var t0 = (window.performance && performance.now()) || 0;
    try {
      var r = await fetch(cfg.baseUrl + '/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var ms = Math.round(((window.performance && performance.now()) || 0) - t0);
      if (!r.ok) {
        logAct('error', { seq: seq, status: r.status, ms: ms });
        var hint = r.status === 429 ? ' (rate limit — try a different provider/key in Settings → Ask AI)' : '';
        showCard('API error ' + r.status + hint + '.'); return;
      }
      var j = await r.json();
      var m = j.choices && j.choices[0] && j.choices[0].message;
      var call = m && m.tool_calls && m.tool_calls[0];
      if (!call) {
        logAct('response', { seq: seq, status: r.status, ms: ms, tool: null, content: ((m && m.content) || '').slice(0, 200) });
        showCard(esc((m && m.content) || 'No action chosen.')); return;
      }
      var args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
      logAct('response', { seq: seq, status: r.status, ms: ms, tool: call.function.name, args: args });
      dispatch(call.function.name, args, text, seq);
    } catch (e) { logAct('error', { seq: seq, err: String(e && e.message || e) }); showCard('Network error: ' + esc(e && e.message || e)); }
  }

  function dispatch(name, args, originalText, seq) {
    if (name === 'clarify') { logAct('dispatch', { seq: seq, kind: 'clarify' }); showClarify(args.message || 'Could you clarify?', originalText, seq); return; }
    if (name === 'propose_plan') { logAct('dispatch', { seq: seq, kind: 'plan', steps: (args.steps || []).length }); showPlan(args.steps || [], originalText); return; }
    if (name === 'go_to_session') {
      var s = liveSessions().filter(function (x) { return x.session === args.session; })[0];
      if (!s) { logAct('dispatch', { seq: seq, kind: 'unknown', id: 'go_to_session' }); showCard('Unknown session: ' + esc(args.session)); return; }
      logAct('dispatch', { seq: seq, kind: 'tool', id: 'go_to_session', resolvedArgs: { session: s.session, pane: s.id } });
      route({ id: 'go_to_session', name: 'Go to: ' + s.session, _run: function () { tv.selectPane && tv.selectPane(s.id); } }, {}, seq);
      return;
    }
    var id = UNSAN(name);
    var def = tv._internal.registries.command.get(id);
    if (!def) { logAct('dispatch', { seq: seq, kind: 'unknown', id: id }); showCard('Chose an unknown command: ' + esc(id)); return; }
    // resolve a session/pane arg label → pane id if the model passed a name
    (def.args || []).forEach(function (a) {
      if ((a.type === 'session' || a.type === 'pane') && args[a.name]) {
        var hit = liveSessions().filter(function (x) { return x.session === args[a.name] || x.id === args[a.name]; })[0];
        if (hit) args[a.name] = hit.id;
      }
    });
    logAct('dispatch', { seq: seq, kind: 'tool', id: id, resolvedArgs: args });
    route(def, args, seq);
  }
  // Auto-run safe (non-danger) actions when the setting is on; else confirm.
  function route(def, args, seq) {
    if (loadSettings().autoRun && !def.danger) {
      dismissCard();                 // clear the "…thinking" spinner; auto-run shows no card
      logAct('result', { seq: seq, action: 'autorun', id: def.id });
      try { execDef(def, args); tv.toast && tv.toast('⚡ ' + (def.name || def.id)); }
      catch (e) { showCard('Command failed: ' + esc(e && e.message || e)); }
      return;
    }
    confirmRun(def, args, { seq: seq, id: def.id });
  }

  // ---- result cards (self-contained, themable) ------------------------
  var cardEl = null;
  function injectStyle() {
    if (document.getElementById('mcc-act-style')) return;
    var st = document.createElement('style'); st.id = 'mcc-act-style';
    st.textContent =
      '#mcc-act-card{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:140;width:min(520px,94vw);' +
      'background:var(--ttv-bg-elev2,#252525);color:var(--ttv-fg,#ddd);border:1px solid var(--ttv-border,#3a3a3a);' +
      'border-radius:10px;box-shadow:0 8px 32px var(--ttv-shadow,#000);font-size:14px;overflow:hidden;}' +
      '#mcc-act-card .mcc-act-body{padding:14px 16px;line-height:1.45;}' +
      '#mcc-act-card .mcc-act-foot{display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;border-top:1px solid var(--ttv-border,#3a3a3a);}' +
      '#mcc-act-card button{padding:8px 14px;border-radius:6px;font:inherit;font-size:14px;cursor:pointer;border:1px solid var(--ttv-border,#3a3a3a);background:transparent;color:var(--ttv-fg,#ddd);}' +
      '#mcc-act-card button.mcc-act-go{border-color:var(--ttv-accent,#E8896B);background:var(--ttv-accent,#E8896B);color:var(--ttv-bg,#1e1e1e);font-weight:600;}' +
      '#mcc-act-card input{width:100%;box-sizing:border-box;padding:9px 11px;margin-top:8px;border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;background:var(--ttv-bg,#1e1e1e);color:var(--ttv-fg,#ddd);font:inherit;font-size:16px;}' +
      '#mcc-act-card ol{margin:6px 0 0;padding-left:20px;} #mcc-act-card code{color:var(--ttv-accent,#E8896B);}';
    document.head.appendChild(st);
  }
  var cardKeyHandler = null;
  function dismissCard() {
    if (cardKeyHandler) { document.removeEventListener('keydown', cardKeyHandler, true); cardKeyHandler = null; }
    if (cardEl) { cardEl.remove(); cardEl = null; }
  }
  // Keyboard-native cards: Enter = primary, Esc = cancel (capture phase so it
  // beats anything underneath). So Ask AI is type → Enter → Enter, no mouse.
  function bindCardKeys(onEnter, onEsc) {
    if (cardKeyHandler) document.removeEventListener('keydown', cardKeyHandler, true);
    cardKeyHandler = function (e) {
      if (e.key === 'Enter' && onEnter) { e.preventDefault(); e.stopPropagation(); onEnter(); }
      else if (e.key === 'Escape' && onEsc) { e.preventDefault(); e.stopPropagation(); onEsc(); }
    };
    document.addEventListener('keydown', cardKeyHandler, true);
  }
  function execDef(def, args) {
    if (typeof def._run === 'function') def._run();
    else if (typeof def.run === 'function') def.run(args || {});
    else if (typeof def.handler === 'function') def.handler();
  }
  function baseCard(bodyHtml) {
    injectStyle(); dismissCard();
    var c = document.createElement('div'); c.id = 'mcc-act-card';
    var body = document.createElement('div'); body.className = 'mcc-act-body'; body.innerHTML = bodyHtml;
    c.appendChild(body); document.body.appendChild(c); cardEl = c;
    return c;
  }
  function showCard(html) {
    var c = baseCard(html);
    var foot = document.createElement('div'); foot.className = 'mcc-act-foot';
    var ok = document.createElement('button'); ok.textContent = 'OK';
    ok.addEventListener('click', dismissCard);
    foot.appendChild(ok); c.appendChild(foot);
  }
  function summarize(args) {
    var keys = Object.keys(args || {});
    if (!keys.length) return '';
    return ' <span style="opacity:.7">(' + keys.map(function (k) { return esc(k) + ': ' + esc(args[k]); }).join(', ') + ')</span>';
  }
  function confirmRun(def, args, meta) {
    meta = meta || {};
    var c = baseCard('Run <b>' + esc(def.name || def.id) + '</b>?' + summarize(args));
    var foot = document.createElement('div'); foot.className = 'mcc-act-foot';
    var cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    function doCancel() { logAct('result', { seq: meta.seq, action: 'cancelled', id: meta.id || def.id }); dismissCard(); }
    function doRun() {
      logAct('result', { seq: meta.seq, action: 'confirmed', id: meta.id || def.id });
      dismissCard();
      try { execDef(def, args); tv.toast && tv.toast('⚡ ' + (def.name || def.id)); }
      catch (e) { showCard('Command failed: ' + esc(e && e.message || e)); }
    }
    cancel.addEventListener('click', doCancel);
    var go = document.createElement('button'); go.className = 'mcc-act-go'; go.textContent = def.danger ? 'Run (danger)' : 'Run';
    go.addEventListener('click', doRun);
    foot.appendChild(cancel); foot.appendChild(go); c.appendChild(foot);
    bindCardKeys(doRun, doCancel);
  }
  function showPlan(steps, originalText) {
    var html = 'This looks like a task, not a one-tap action:<ol>' +
      steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<div style="margin-top:10px;opacity:.8">Hand it to a session with <code>Send to session…</code>.</div>';
    var c = baseCard(html);
    var foot = document.createElement('div'); foot.className = 'mcc-act-foot';
    var close = document.createElement('button'); close.textContent = 'Close'; close.addEventListener('click', dismissCard);
    var send = document.createElement('button'); send.className = 'mcc-act-go'; send.textContent = 'Send to session…';
    send.addEventListener('click', function () {
      dismissCard();
      var def = tv._internal.registries.command.get('mcc.send');
      if (def && typeof tv.openCommandPalette === 'function') { tv.openCommandPalette(); /* user picks target + pastes the task */ }
    });
    foot.appendChild(close); if (tv._internal.registries.command.get('mcc.send')) foot.appendChild(send);
    c.appendChild(foot);
  }
  function showClarify(message, originalText, seq) {
    logAct('clarify', { seq: seq, q: message });
    var c = baseCard(esc(message));
    var inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Your answer…';
    c.querySelector('.mcc-act-body').appendChild(inp);
    var foot = document.createElement('div'); foot.className = 'mcc-act-foot';
    var cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.addEventListener('click', dismissCard);
    var go = document.createElement('button'); go.className = 'mcc-act-go'; go.textContent = 'Answer';
    function answer() { var a = inp.value.trim(); dismissCard(); runAct(originalText + '\n\nClarification: ' + a, 'clarify'); }
    go.addEventListener('click', answer);
    foot.appendChild(cancel); foot.appendChild(go); c.appendChild(foot);
    bindCardKeys(answer, dismissCard);
    requestAnimationFrame(function () { inp.focus(); });
  }

  // ---- entry point: an args-bearing palette command -------------------
  tv.contributes.command({
    id: 'mcc.ai',
    name: 'Ask AI…',
    group: 'AI',
    keywords: ['ai', 'act', 'do', 'natural language', 'assistant', 'agent', 'command'],
    args: [{ name: 'q', type: 'text', required: true, describe: 'What do you want to do?' }],
    run: function (a) { if (a.q) runAct(a.q, 'command'); },
  });

  // ---- Ctrl-K integration: an "Ask AI: <query>" fallback row -----------
  // Sentence-like query → priority:'top' (pre-selected, Enter fires AI);
  // otherwise it sits below the command matches. Cmd/Ctrl-Enter always fires it
  // (core handles that). This is the zero-friction path: Ctrl-K → type → Enter.
  if (typeof tv.contributes.paletteSuggest === 'function') {
    tv.contributes.paletteSuggest({
      id: 'mcc.ai',
      suggest: function (query) {
        var q = (query || '').trim();
        if (!q) return [];
        return [{
          id: 'mcc.ai', title: '✨ Ask AI: ' + q, hint: 'natural language → action',
          priority: sentenceLike(q) ? 'top' : 'bottom',
          run: function () { runAct(q, 'palette'); },
        }];
      },
    });
  }

  // ---- history suggester: recents on empty, matches while typing -------
  if (typeof tv.contributes.paletteSuggest === 'function') {
    tv.contributes.paletteSuggest({
      id: 'mcc.history',
      suggest: function (query) {
        var q = (query || '').trim().toLowerCase();
        var items = histLoad();
        if (!items.length) return [];
        var rows, pri;
        if (!q) { rows = items.slice(0, 8); pri = 'top'; }       // empty → recents up top, newest pre-selected
        else { rows = items.filter(function (e) { return histText(e).toLowerCase().indexOf(q) >= 0; }).slice(0, 6); pri = 'bottom'; }
        return rows.map(function (e) {
          return { id: 'mcc.history', title: histLabel(e), hint: 'recent', priority: pri,
                   run: (function (entry) { return function () { histReplay(entry); }; })(e) };
        });
      },
    });
  }

  // ---- interaction logging + history recording -------------------------
  if (typeof tv.on === 'function') {
    tv.on('palette-open', function () { logPal('open', {}); });
    tv.on('command-invoked', function (e) { logPal('invoke', { id: e && e.id, q: e && e.query, suggest: !!(e && e.suggest) }); });
    tv.on('command-run', function (e) {
      logPal('run', { id: e && e.id, args: e && e.args });
      if (e && e.id && e.id !== 'mcc.ai') histPush({ kind: 'cmd', id: e.id, args: e.args || {} });  // AI text recorded separately
    });
  }

  // ---- Settings → Ask AI: dedicated Groq key + model ------------------
  tv.contributes.settingsTab({
    id: 'mobile-cc-act',
    title: 'Ask AI',
    render: function (container) {
      container.innerHTML = '';
      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 14px;line-height:1.5;';
      intro.innerHTML = 'Natural-language command router — open the palette and pick <b>Ask AI…</b>. ' +
        'Runs an OpenAI-compatible chat model in your browser. Choose a provider and paste its key. ' +
        '(Groq with no key falls back to the Voice Input key.)';
      container.appendChild(intro);

      function field(labelText) {
        var w = document.createElement('label');
        w.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:14px;font-size:13px;color:var(--ttv-muted);';
        var l = document.createElement('span'); l.textContent = labelText; w.appendChild(l);
        return w;
      }
      var inputCss = 'padding:10px 11px;border:1px solid var(--ttv-border);border-radius:6px;background:var(--ttv-bg);color:var(--ttv-fg);font:inherit;font-size:16px;';
      function save(patch) { var cur = loadSettings(); for (var k in patch) cur[k] = patch[k]; STORE.set('settings', cur); }
      var s = loadSettings();

      var pw = field('Provider');
      var prov = document.createElement('select'); prov.style.cssText = inputCss;
      Object.keys(PROVIDERS).forEach(function (id) {
        var o = document.createElement('option'); o.value = id; o.textContent = PROVIDERS[id].label;
        if (id === s.provider) o.selected = true; prov.appendChild(o);
      });
      pw.appendChild(prov); container.appendChild(pw);

      var bw = field('API base URL');
      var base = document.createElement('input');
      base.type = 'text'; base.placeholder = 'https://…/v1'; base.spellcheck = false;
      base.setAttribute('autocorrect', 'off'); base.setAttribute('autocapitalize', 'off');
      base.value = s.provider === 'custom' ? s.baseUrl : '';
      base.style.cssText = inputCss;
      base.addEventListener('change', function () { save({ baseUrl: base.value.trim() }); });
      bw.appendChild(base); container.appendChild(bw);
      function syncBaseVisible() { bw.style.display = (prov.value === 'custom') ? '' : 'none'; }

      var kw = field('API key');
      var key = document.createElement('input');
      key.type = 'text'; key.placeholder = 'sk-… / gsk-…';
      key.spellcheck = false;
      key.setAttribute('autocorrect', 'off'); key.setAttribute('autocapitalize', 'off');
      key.setAttribute('data-lpignore', 'true'); key.setAttribute('data-1p-ignore', 'true'); key.setAttribute('data-bwignore', 'true');
      key.value = s.key;
      key.style.cssText = inputCss + '-webkit-text-security:disc;';
      key.addEventListener('change', function () { save({ key: key.value.trim() }); });
      kw.appendChild(key); container.appendChild(kw);

      var mw = field('Model');
      var model = document.createElement('input');
      model.type = 'text'; model.value = s.model; model.spellcheck = false;
      model.setAttribute('autocorrect', 'off'); model.setAttribute('autocapitalize', 'off');
      model.style.cssText = inputCss;
      model.addEventListener('change', function () { save({ model: model.value.trim() || PROVIDERS[prov.value].model }); });
      mw.appendChild(model); container.appendChild(mw);

      // auto-run toggle
      var aw = document.createElement('label');
      aw.style.cssText = 'display:flex;align-items:flex-start;gap:8px;margin-bottom:14px;font-size:13px;color:var(--ttv-fg);cursor:pointer;';
      var auto = document.createElement('input'); auto.type = 'checkbox'; auto.checked = !!s.autoRun;
      auto.style.cssText = 'margin-top:2px;';
      auto.addEventListener('change', function () { save({ autoRun: auto.checked }); });
      var aspan = document.createElement('span');
      aspan.innerHTML = 'Auto-run safe actions <span style="color:var(--ttv-muted)">— skip the confirm card for non-danger actions (still confirms danger ones). Type → Enter → done.</span>';
      aw.appendChild(auto); aw.appendChild(aspan); container.appendChild(aw);

      prov.addEventListener('change', function () {
        save({ provider: prov.value });
        var d = PROVIDERS[prov.value];
        if (d.model) { model.value = d.model; save({ model: d.model }); }
        syncBaseVisible();
      });
      syncBaseVisible();

      var hint = document.createElement('p');
      hint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin:4px 0 0;';
      hint.innerHTML = 'Keys: platform.openai.com/api-keys or console.groq.com/keys. Stored in this browser profile (server-synced across your devices).';
      container.appendChild(hint);
    },
  });

  // expose for a future voice hook / other plugins
  window.mccAct = runAct;
})();
