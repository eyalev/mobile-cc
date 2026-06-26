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

  var GROQ = 'https://api.groq.com/openai/v1/chat/completions';
  var DEFAULT_MODEL = 'llama-3.3-70b-versatile';   // matches the STT cleanup model
  var STORE = tv.storage('mobile-cc-act');

  function loadSettings() {
    var s = {};
    try { s = STORE.get('settings') || {}; } catch (e) {}
    return { groqKey: s.groqKey || '', model: s.model || DEFAULT_MODEL };
  }
  // Prefer Ask AI's OWN Groq key (its own rate-limit quota); fall back to the
  // STT key so it still works if you've only set one.
  function groqKey() {
    var own = loadSettings().groqKey;
    if (own) return own;
    try { return (tv.storage('ttyview-stt-groq').get('settings') || {}).groqKey || ''; }
    catch (e) { return ''; }
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
    var key = groqKey();
    if (!key) { showCard('<b>No Groq key set.</b><br>Add one in Settings → Voice Input to use Ask AI.'); return; }
    showCard('<span style="opacity:.7">…thinking</span>');
    var sess = liveSessions();
    var ctx = sess.length ? sess.map(function (s) { return '- ' + s.session + ' (pane ' + s.id + ')'; }).join('\n') : '(none)';
    var body = {
      model: loadSettings().model, temperature: 0, tool_choice: 'required', tools: buildTools(),
      messages: [
        { role: 'system', content: SYS + '\n\nLive sessions:\n' + ctx },
        { role: 'user', content: text },
      ],
    };
    try {
      var r = await fetch(GROQ, { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { showCard('Groq error ' + r.status + '. Check the key / rate limit in Settings → Voice Input.'); return; }
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
        'Runs Groq (<code>' + esc(DEFAULT_MODEL) + '</code>) directly from your browser. Set a <b>dedicated</b> ' +
        'key here so Ask AI doesn’t share the Voice Input key’s rate limit. Blank = fall back to the Voice Input key.';
      container.appendChild(intro);

      function field(labelText) {
        var w = document.createElement('label');
        w.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:14px;font-size:13px;color:var(--ttv-muted);';
        var l = document.createElement('span'); l.textContent = labelText; w.appendChild(l);
        return w;
      }
      var inputCss = 'padding:10px 11px;border:1px solid var(--ttv-border);border-radius:6px;background:var(--ttv-bg);color:var(--ttv-fg);font:inherit;font-size:16px;';
      var s = loadSettings();

      var kw = field('Groq API key (Ask AI)');
      var key = document.createElement('input');
      key.type = 'text'; key.placeholder = 'gsk_…  (blank = use Voice Input key)';
      key.spellcheck = false;
      key.setAttribute('autocorrect', 'off'); key.setAttribute('autocapitalize', 'off');
      key.setAttribute('data-lpignore', 'true'); key.setAttribute('data-1p-ignore', 'true'); key.setAttribute('data-bwignore', 'true');
      key.value = s.groqKey;
      key.style.cssText = inputCss + '-webkit-text-security:disc;';
      key.addEventListener('change', function () { var cur = loadSettings(); cur.groqKey = key.value.trim(); STORE.set('settings', cur); });
      kw.appendChild(key); container.appendChild(kw);

      var mw = field('Model');
      var model = document.createElement('input');
      model.type = 'text'; model.value = s.model; model.spellcheck = false;
      model.setAttribute('autocorrect', 'off'); model.setAttribute('autocapitalize', 'off');
      model.style.cssText = inputCss;
      model.addEventListener('change', function () { var cur = loadSettings(); cur.model = model.value.trim() || DEFAULT_MODEL; STORE.set('settings', cur); });
      mw.appendChild(model); container.appendChild(mw);

      var hint = document.createElement('p');
      hint.style.cssText = 'color:var(--ttv-muted);font-size:11px;margin:4px 0 0;';
      hint.innerHTML = 'Free keys at console.groq.com/keys. Stored in this browser profile (server-synced across your devices).';
      container.appendChild(hint);
    },
  });

  // expose for a future voice hook / other plugins
  window.mccAct = runAct;
})();
