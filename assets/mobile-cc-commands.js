// mobile-cc-commands — one-tap command chips above the message box.
//
// The friction this removes: typing recurring short commands on a phone
// keyboard. Each chip sends its command string + Enter to the active
// pane via window.ttyview.sendInput() — so launching Claude Code is one
// tap of the seeded `▶ cc` chip (runs `ccpc`, the continue-or-start
// bash function), not a hand-typed word. The list is user-editable in
// Settings → Commands, so `cc`, `clear`, `git push`, etc. are a chip
// away too.
//
// Two contributions, one closure so they share state:
//   - inputAccessory: renders the chip row, re-rendered after edits.
//   - settingsTab:    add / edit / remove / reorder commands.
//
// State lives in per-plugin scoped storage (server-synced → one device's
// edits reach them all). Seeded only when the key is ABSENT, so an empty
// list is a respected user choice and never re-seeded.
//
// Touch handling mirrors ttyview-quickkeys: pointerup (not click — on
// Android Chrome the touchstart.preventDefault that keeps the textarea
// focused also eats the synthetic click), tabIndex=-1 + mousedown
// .preventDefault so a tap never blurs the Message box.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-commands] requires apiVersion 1');
    return;
  }

  var STORAGE = tv.storage('mobile-cc-commands');
  var KEY = 'commands';

  // Seeded on first run only. `cmd` is sent verbatim followed by CR.
  var DEFAULT = [{ label: '▶ cc', cmd: 'ccpc' }];

  function load() {
    var v = STORAGE.get(KEY);
    if (v == null) return DEFAULT.slice();           // absent → seed
    if (!Array.isArray(v)) return [];
    return v.filter(function (c) {
      return c && typeof c.cmd === 'string';
    });
  }
  function save(list) {
    STORAGE.set(KEY, list);
  }

  // Set of mounted chip-row re-render callbacks. The settings tab calls
  // these after any edit so open accessory rows update live.
  var rerenders = [];
  function rerenderAll() {
    for (var i = 0; i < rerenders.length; i++) {
      try { rerenders[i](); } catch (e) {}
    }
  }

  // ---- inputAccessory: the chip row -------------------------------------

  tv.contributes.inputAccessory({
    id: 'mobile-cc-commands',
    name: 'Commands',
    render: function (slot) {
      var row = document.createElement('div');
      row.style.cssText =
        'display:flex;gap:4px;overflow-x:auto;-webkit-overflow-scrolling:touch;' +
        'padding:2px 0;scrollbar-width:none;';

      function paint() {
        row.innerHTML = '';
        var list = load();
        for (var i = 0; i < list.length; i++) {
          row.appendChild(makeChip(list[i]));
        }
      }

      function makeChip(c) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.tabIndex = -1;                 // not focusable → tap keeps textarea focus
        btn.title = c.cmd;
        // Render the label, enlarging any ↵ (return) glyph so it reads as an
        // icon — the rest of the label and the chip size stay unchanged.
        var lbl = String(c.label || c.cmd);
        var segs = lbl.split('↵');
        for (var s = 0; s < segs.length; s++) {
          if (segs[s]) btn.appendChild(document.createTextNode(segs[s]));
          if (s < segs.length - 1) {
            var ret = document.createElement('span');
            ret.textContent = '↵';
            // Scale via transform (not font-size) so the glyph looks bigger
            // without growing the line box / chip height.
            ret.style.cssText =
              'display:inline-block;transform:scale(1.5);transform-origin:center;';
            btn.appendChild(ret);
          }
        }
        // a11y: aria-label = the human label (title already carries the raw cmd
        // for the tooltip). Keeps the SR announcement readable.
        btn.setAttribute('aria-label', String(c.label || c.cmd));
        // Single BLUE accent for the seeded launch chip (▶ …); every other chip
        // is neutral + theme-aware. No coral anywhere; normal (compact) size.
        var isAccent = lbl.trim().charAt(0) === '▶';
        var accentCol = 'var(--ttv-accent, #569cd6)';
        var chipColor = isAccent ? accentCol : 'var(--ttv-fg)';
        var chipBorder = isAccent ? accentCol : 'var(--ttv-border, #3a3a3a)';
        btn.style.cssText =
          'flex:none;padding:4px 10px;' +
          'border:1px solid ' + chipBorder + ';' +
          'border-radius:8px;background:transparent;color:' + chipColor + ';' +
          'font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer;' +
          'font-family:inherit;line-height:1.2;';
        btn.addEventListener('pointerup', function (e) {
          if (e.button !== undefined && e.button !== 0) return;  // ignore right/middle
          if (typeof window.ttvDiag === 'function') {
            window.ttvDiag('cmd-tap', { label: c.label, cmd: c.cmd, ptr: e.pointerType });
          }
          var ok = tv.sendInput(null, c.cmd + '\r');
          if (typeof window.ttvDiag === 'function') {
            window.ttvDiag('cmd-result', { cmd: c.cmd, ok: !!ok });
          }
        });
        // Cancel desktop focus-on-mousedown (touch path is covered by tabIndex=-1).
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
        return btn;
      }

      paint();
      slot.appendChild(row);
      rerenders.push(paint);

      return function unmount() {
        var i = rerenders.indexOf(paint);
        if (i >= 0) rerenders.splice(i, 1);
        row.remove();
      };
    },
  });

  // ---- settingsTab: edit the command list -------------------------------

  tv.contributes.settingsTab({
    id: 'mobile-cc-commands',
    title: 'Commands',
    render: function (container) {
      container.innerHTML = '';

      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 16px;';
      intro.textContent =
        'One-tap chips above the Message box. Tapping a chip sends its ' +
        'command followed by Enter to the active pane. Edits sync across ' +
        'your devices and apply instantly.';
      container.appendChild(intro);

      var listWrap = document.createElement('div');
      container.appendChild(listWrap);

      function commit(list) {
        save(list);
        rerenderAll();
      }

      function drawRows() {
        listWrap.innerHTML = '';
        var list = load();

        list.forEach(function (c, idx) {
          var rowEl = document.createElement('div');
          rowEl.style.cssText =
            'display:flex;gap:8px;align-items:center;margin-bottom:10px;';

          var labelIn = document.createElement('input');
          labelIn.type = 'text';
          labelIn.value = c.label || '';
          labelIn.placeholder = 'Label';
          labelIn.style.cssText =
            'width:96px;flex:none;padding:6px 8px;border:1px solid var(--ttv-border,#3a3a3a);' +
            'border-radius:6px;background:var(--ttv-bg,#1b1b1b);color:var(--ttv-fg);' +
            'font-size:13px;font-family:inherit;';
          labelIn.addEventListener('change', function () {
            list[idx].label = labelIn.value;
            commit(list);
          });

          var cmdIn = document.createElement('input');
          cmdIn.type = 'text';
          cmdIn.value = c.cmd || '';
          cmdIn.placeholder = 'command (sent + Enter)';
          cmdIn.style.cssText =
            'flex:1;min-width:0;padding:6px 8px;border:1px solid var(--ttv-border,#3a3a3a);' +
            'border-radius:6px;background:var(--ttv-bg,#1b1b1b);color:var(--ttv-fg);' +
            'font-size:13px;font-family:ui-monospace,monospace;';
          cmdIn.addEventListener('change', function () {
            list[idx].cmd = cmdIn.value;
            commit(list);
          });

          var del = document.createElement('button');
          del.type = 'button';
          del.textContent = '✕';
          del.title = 'Remove';
          del.setAttribute('aria-label', 'Remove command');
          del.style.cssText =
            'flex:none;width:40px;height:40px;border:1px solid var(--ttv-border,#3a3a3a);' +
            'border-radius:6px;background:transparent;color:var(--ttv-muted);' +
            'font-size:14px;cursor:pointer;';
          del.addEventListener('click', function () {
            list.splice(idx, 1);
            commit(list);
            drawRows();
          });

          rowEl.appendChild(labelIn);
          rowEl.appendChild(cmdIn);
          rowEl.appendChild(del);
          listWrap.appendChild(rowEl);
        });

        if (list.length === 0) {
          var empty = document.createElement('div');
          empty.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:4px 0 12px;';
          empty.textContent = 'No commands. Add one below.';
          listWrap.appendChild(empty);
        }
      }

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;';

      var add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Add command';
      add.style.cssText =
        'padding:7px 12px;border:1px solid var(--ttv-rail-accent,#569cd6);border-radius:6px;' +
        'background:transparent;color:var(--ttv-rail-accent-text,#569cd6);font-size:13px;' +
        'font-weight:600;cursor:pointer;font-family:inherit;';
      add.addEventListener('click', function () {
        var list = load();
        list.push({ label: '', cmd: '' });
        commit(list);
        drawRows();
      });

      var reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = 'Reset to default';
      reset.style.cssText =
        'padding:7px 12px;border:1px solid var(--ttv-border,#3a3a3a);border-radius:6px;' +
        'background:transparent;color:var(--ttv-muted);font-size:13px;cursor:pointer;' +
        'font-family:inherit;';
      reset.addEventListener('click', function () {
        commit(DEFAULT.slice());
        drawRows();
      });

      btnRow.appendChild(add);
      btnRow.appendChild(reset);
      container.appendChild(btnRow);

      drawRows();
    },
  });
})();
