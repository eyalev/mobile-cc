// mobile-cc-quickkeys — editable special-key buttons above the message box.
//
// Replaces the upstream ttyview-quickkeys (whose key list was hardcoded).
// Same job: a row of Esc / Tab / arrow / Ctrl-* buttons that the soft
// keyboard can't reach, each sending its key sequence to the active pane
// via window.ttyview.sendInput(). The difference: the list is
// user-editable in Settings → Quick Keys (add / edit / remove / reset),
// so you manage which buttons appear — including dropping Ctrl-L.
//
// Key sequences are stored in a readable notation and decoded on send:
//   \e            Esc (ESC, \x1b)        \r \n \t \\   the literals
//   \xNN          a raw byte in hex      ^C ^D ^L ...  Ctrl-<letter>
//   \e[A \e[B \e[D \e[C                  Up / Down / Left / Right
// Anything else is sent verbatim.
//
// Two contributions, one closure so they share state:
//   - inputAccessory: renders the key row, re-rendered after edits.
//   - settingsTab:    add / edit / remove / reset the key list.
//
// State lives in per-plugin scoped storage (server-synced → one device's
// edits reach them all). Seeded only when the key is ABSENT, so an empty
// list is a respected user choice and never re-seeded.
//
// Touch handling mirrors the old ttyview-quickkeys: pointerup (not click —
// on Android Chrome the touchstart.preventDefault that keeps the textarea
// focused also eats the synthetic click), tabIndex=-1 + mousedown
// .preventDefault so a tap never blurs the Message box.
(function () {
  var tv = window.ttyview;
  if (!tv || tv.apiVersion !== 1) {
    console.warn('[mobile-cc-quickkeys] requires apiVersion 1');
    return;
  }

  var STORAGE = tv.storage('mobile-cc-quickkeys');
  var KEY = 'keys';

  // Seeded on first run only. Ctrl-L deliberately omitted — add it back
  // in Settings → Quick Keys with keys `^L` if you want it.
  var DEFAULT = [
    { label: 'Esc',    keys: '\\e'   },
    { label: 'Tab',    keys: '\\t'   },
    { label: '↑',      keys: '\\e[A' },
    { label: '↓',      keys: '\\e[B' },
    { label: '←',      keys: '\\e[D' },
    { label: '→',      keys: '\\e[C' },
    { label: 'Ctrl-C', keys: '^C'    },
    { label: 'Ctrl-D', keys: '^D'    },
    { label: 'Enter',  keys: '\\r'   },
  ];

  // Decode the readable notation above into the raw bytes to send.
  function decode(s) {
    if (typeof s !== 'string') return '';
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        var n = s[i + 1];
        if (n === 'e') { out += '\x1b'; i++; }
        else if (n === 'r') { out += '\r'; i++; }
        else if (n === 'n') { out += '\n'; i++; }
        else if (n === 't') { out += '\t'; i++; }
        else if (n === '0') { out += '\x00'; i++; }
        else if (n === '\\') { out += '\\'; i++; }
        else if (n === 'x') {
          var hex = s.substr(i + 2, 2);
          var code = parseInt(hex, 16);
          if (/^[0-9a-fA-F]{2}$/.test(hex) && !isNaN(code)) { out += String.fromCharCode(code); i += 3; }
          else { out += ch; }
        } else { out += ch; }
      } else if (ch === '^' && i + 1 < s.length) {
        var c = s.charCodeAt(i + 1);
        var up = String.fromCharCode(c).toUpperCase().charCodeAt(0);
        if (s[i + 1] === '?') { out += '\x7f'; i++; }          // ^? = DEL
        else if (up >= 64 && up <= 95) { out += String.fromCharCode(up - 64); i++; }  // ^@..^_
        else { out += ch; }
      } else {
        out += ch;
      }
    }
    return out;
  }

  function load() {
    var v = STORAGE.get(KEY);
    if (v == null) return DEFAULT.slice();           // absent → seed
    if (!Array.isArray(v)) return [];
    return v.filter(function (k) {
      return k && typeof k.keys === 'string';
    });
  }
  function save(list) {
    STORAGE.set(KEY, list);
  }

  // Set of mounted key-row re-render callbacks. The settings tab calls
  // these after any edit so open accessory rows update live.
  var rerenders = [];
  function rerenderAll() {
    for (var i = 0; i < rerenders.length; i++) {
      try { rerenders[i](); } catch (e) {}
    }
  }

  // ---- inputAccessory: the key row --------------------------------------

  tv.contributes.inputAccessory({
    id: 'mobile-cc-quickkeys',
    name: 'Quick Keys',
    render: function (slot) {
      var row = document.createElement('div');
      row.style.cssText =
        'display:flex;gap:3px;overflow-x:auto;-webkit-overflow-scrolling:touch;' +
        'padding:2px 0;scrollbar-width:none;';

      function paint() {
        row.innerHTML = '';
        var list = load();
        for (var i = 0; i < list.length; i++) {
          row.appendChild(makeBtn(list[i]));
        }
      }

      function makeBtn(k) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.tabIndex = -1;                 // not focusable → tap keeps textarea focus
        btn.textContent = k.label || k.keys;
        // a11y: announce the human label, NOT the raw escape sequence (a screen
        // reader would read "\x1b[A" as "escape bracket A"). Tooltip = same label.
        var human = k.label || k.keys;
        btn.setAttribute('aria-label', human);
        btn.title = human;
        // Touch target: guarantee ≥36px tall / ≥40px wide regardless of the
        // inherited accessory-button style (WCAG 2.5.5).
        btn.style.minHeight = '36px';
        btn.style.minWidth = '40px';
        btn.addEventListener('pointerup', function (e) {
          if (e.button !== undefined && e.button !== 0) return;  // ignore right/middle
          if (typeof window.ttvDiag === 'function') {
            window.ttvDiag('qk-tap', { label: k.label, keys: k.keys, ptr: e.pointerType });
          }
          var ok = tv.sendInput(null, decode(k.keys));
          if (typeof window.ttvDiag === 'function') {
            window.ttvDiag('qk-result', { label: k.label, ok: !!ok });
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

  // ---- settingsTab: edit the key list -----------------------------------

  tv.contributes.settingsTab({
    id: 'mobile-cc-quickkeys',
    title: 'Quick Keys',
    render: function (container) {
      container.innerHTML = '';

      var intro = document.createElement('p');
      intro.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:0 0 8px;';
      intro.textContent =
        'Buttons above the Message box for keys the soft keyboard can\'t ' +
        'reach. Tapping a button sends its key sequence to the active pane. ' +
        'Edits sync across your devices and apply instantly.';
      container.appendChild(intro);

      var notation = document.createElement('p');
      notation.style.cssText =
        'color:var(--ttv-muted);font-size:11px;margin:0 0 16px;' +
        'font-family:ui-monospace,monospace;line-height:1.5;';
      notation.innerHTML =
        'Notation: <b>\\e</b>=Esc &nbsp; <b>\\r</b>=Enter &nbsp; <b>\\t</b>=Tab &nbsp; ' +
        '<b>^C</b>=Ctrl-C &nbsp; <b>^L</b>=Ctrl-L &nbsp; <b>\\xNN</b>=hex byte<br>' +
        'Arrows: <b>\\e[A</b> Up &nbsp; <b>\\e[B</b> Down &nbsp; <b>\\e[D</b> Left &nbsp; <b>\\e[C</b> Right';
      container.appendChild(notation);

      var listWrap = document.createElement('div');
      container.appendChild(listWrap);

      function commit(list) {
        save(list);
        rerenderAll();
      }

      function drawRows() {
        listWrap.innerHTML = '';
        var list = load();

        list.forEach(function (k, idx) {
          var rowEl = document.createElement('div');
          rowEl.style.cssText =
            'display:flex;gap:8px;align-items:center;margin-bottom:10px;';

          var labelIn = document.createElement('input');
          labelIn.type = 'text';
          labelIn.value = k.label || '';
          labelIn.placeholder = 'Label';
          labelIn.style.cssText =
            'width:96px;flex:none;padding:6px 8px;border:1px solid var(--ttv-border,#3a3a3a);' +
            'border-radius:6px;background:var(--ttv-bg,#1b1b1b);color:var(--ttv-fg);' +
            'font-size:13px;font-family:inherit;';
          labelIn.addEventListener('change', function () {
            list[idx].label = labelIn.value;
            commit(list);
          });

          var keysIn = document.createElement('input');
          keysIn.type = 'text';
          keysIn.value = k.keys || '';
          keysIn.placeholder = 'keys (e.g. \\e, ^C, \\e[A)';
          keysIn.autocapitalize = 'off';
          keysIn.autocomplete = 'off';
          keysIn.spellcheck = false;
          keysIn.style.cssText =
            'flex:1;min-width:0;padding:6px 8px;border:1px solid var(--ttv-border,#3a3a3a);' +
            'border-radius:6px;background:var(--ttv-bg,#1b1b1b);color:var(--ttv-fg);' +
            'font-size:13px;font-family:ui-monospace,monospace;';
          keysIn.addEventListener('change', function () {
            list[idx].keys = keysIn.value;
            commit(list);
          });

          var del = document.createElement('button');
          del.type = 'button';
          del.textContent = '✕';
          del.title = 'Remove';
          del.setAttribute('aria-label', 'Remove quick key');
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
          rowEl.appendChild(keysIn);
          rowEl.appendChild(del);
          listWrap.appendChild(rowEl);
        });

        if (list.length === 0) {
          var empty = document.createElement('div');
          empty.style.cssText = 'color:var(--ttv-muted);font-size:12px;margin:4px 0 12px;';
          empty.textContent = 'No quick keys. Add one below.';
          listWrap.appendChild(empty);
        }
      }

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;';

      var add = document.createElement('button');
      add.type = 'button';
      add.textContent = '+ Add key';
      add.style.cssText =
        'padding:7px 12px;border:1px solid var(--ttv-rail-accent,#E8896B);border-radius:6px;' +
        'background:transparent;color:var(--ttv-rail-accent-text,#E8896B);font-size:13px;' +
        'font-weight:600;cursor:pointer;font-family:inherit;';
      add.addEventListener('click', function () {
        var list = load();
        list.push({ label: '', keys: '' });
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
