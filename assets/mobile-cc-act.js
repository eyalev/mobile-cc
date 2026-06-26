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

  // ---- the call --------------------------------------------------------
  async function runAct(text) {
    var cfg = loadSettings();
    var key = apiKey();
    if (!key) { showCard('<b>No API key set.</b><br>Add one in Settings → Ask AI.'); return; }
    if (!cfg.baseUrl) { showCard('<b>No API base URL.</b><br>Pick a provider in Settings → Ask AI.'); return; }
    showCard('<span style="opacity:.7">…thinking</span>');
    var sess = liveSessions();
    var ctx = sess.length ? sess.map(function (s) { return '- ' + s.session + ' (pane ' + s.id + ')'; }).join('\n') : '(none)';
    var body = {
      model: cfg.model, temperature: 0, tool_choice: 'required', tools: buildTools(),
      messages: [
        { role: 'system', content: SYS + '\n\nLive sessions:\n' + ctx },
        { role: 'user', content: text },
      ],
    };
    try {
      var r = await fetch(cfg.baseUrl + '/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) {
        var hint = r.status === 429 ? ' (rate limit — try a different provider/key in Settings → Ask AI)' : '';
        showCard('API error ' + r.status + hint + '.'); return;
      }
      var j = await r.json();
      var m = j.choices && j.choices[0] && j.choices[0].message;
      var call = m && m.tool_calls && m.tool_calls[0];
      if (!call) { showCard(esc((m && m.content) || 'No action chosen.')); return; }
      var args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
      dispatch(call.function.name, args, text);
    } catch (e) { showCard('Network error: ' + esc(e && e.message || e)); }
  }

  function dispatch(name, args, originalText) {
    if (name === 'clarify') { showClarify(args.message || 'Could you clarify?', originalText); return; }
    if (name === 'propose_plan') { showPlan(args.steps || [], originalText); return; }
    if (name === 'go_to_session') {
      var s = liveSessions().filter(function (x) { return x.session === args.session; })[0];
      if (!s) { showCard('Unknown session: ' + esc(args.session)); return; }
      confirmRun({ name: 'Go to: ' + s.session, _run: function () { tv.selectPane && tv.selectPane(s.id); } }, {});
      return;
    }
    var id = UNSAN(name);
    var def = tv._internal.registries.command.get(id);
    if (!def) { showCard('Chose an unknown command: ' + esc(id)); return; }
    // resolve a session/pane arg label → pane id if the model passed a name
    (def.args || []).forEach(function (a) {
      if ((a.type === 'session' || a.type === 'pane') && args[a.name]) {
        var hit = liveSessions().filter(function (x) { return x.session === args[a.name] || x.id === args[a.name]; })[0];
        if (hit) args[a.name] = hit.id;
      }
    });
    confirmRun(def, args);
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
  function dismissCard() { if (cardEl) { cardEl.remove(); cardEl = null; } }
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
  function confirmRun(def, args) {
    var c = baseCard('Run <b>' + esc(def.name || def.id) + '</b>?' + summarize(args));
    var foot = document.createElement('div'); foot.className = 'mcc-act-foot';
    var cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.addEventListener('click', dismissCard);
    var go = document.createElement('button'); go.className = 'mcc-act-go'; go.textContent = def.danger ? 'Run (danger)' : 'Run';
    go.addEventListener('click', function () {
      dismissCard();
      try {
        if (typeof def._run === 'function') def._run();
        else if (typeof def.run === 'function') def.run(args || {});
        else if (typeof def.handler === 'function') def.handler();
        tv.toast && tv.toast('⚡ ' + (def.name || def.id));
      } catch (e) { showCard('Command failed: ' + esc(e && e.message || e)); }
    });
    foot.appendChild(cancel); foot.appendChild(go); c.appendChild(foot);
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
  function showClarify(message, originalText) {
    var c = baseCard(esc(message));
    var inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'Your answer…';
    c.querySelector('.mcc-act-body').appendChild(inp);
    var foot = document.createElement('div'); foot.className = 'mcc-act-foot';
    var cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.addEventListener('click', dismissCard);
    var go = document.createElement('button'); go.className = 'mcc-act-go'; go.textContent = 'Answer';
    go.addEventListener('click', function () { var a = inp.value.trim(); dismissCard(); runAct(originalText + '\n\nClarification: ' + a); });
    foot.appendChild(cancel); foot.appendChild(go); c.appendChild(foot);
    requestAnimationFrame(function () { inp.focus(); });
  }

  // ---- entry point: an args-bearing palette command -------------------
  tv.contributes.command({
    id: 'mcc.ai',
    name: 'Ask AI…',
    group: 'AI',
    keywords: ['ai', 'act', 'do', 'natural language', 'assistant', 'agent', 'command'],
    args: [{ name: 'q', type: 'text', required: true, describe: 'What do you want to do?' }],
    run: function (a) { if (a.q) runAct(a.q); },
  });

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
