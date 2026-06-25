// day-in-the-life — the "how you actually use mobile-cc through your day" clip.
// Starts near-fresh (one Claude Code session = this morning's work) and builds
// up: compose a reply, spin up a second workspace, get a "needs you" status
// dot on the session waiting on a permission prompt, jump to it, then open the
// pane picker to find any session. The full 7-beat narrative.
//
// Capture it leak-safe + isolated (its own synthetic daemon, zero real
// sessions) with:
//   demos/local-capture.sh day-in-the-life
// Uses the `day-start` profile (one seeded session). Standard resolution from
// lib/capture.mjs.
//
// HONESTY (see demos/CONVENTIONS.md "Determinism"): panes show a SEEDED
// Claude-Code-TUI mock (no live Anthropic token in the isolated capture); the
// new tab is created via the real "Blank tab" menu path (we don't spawn a real
// `claude`); we COMPOSE a reply but don't Send (Send would dump into the mock
// shell); the "needs you" dot is staged with a seeded semantic event. Every
// gesture is a real UI action, asserted in validate().

const PROMPT = process.env.DAY_PROMPT || 'ship the retry-backoff fix when tests pass';

// The session that starts as your single tab ("this morning's work").
const FIRST = 'api-claude1';

/** @type {import('../lib/workflow.mjs').Workflow} */
export default {
  id: 'day-in-the-life',
  title: 'A day with mobile-cc',
  description:
    "How you actually drive Claude Code from your phone across a day: open " +
    "this morning's session, compose a reply (one-tap command chips above the " +
    "box), spin up a second workspace, get a 'needs you' dot when a session " +
    "hits a permission prompt, jump to it, and use the pane picker to find any " +
    "session. Near-fresh → juggling multiple tabs.",

  run: async (ctx) => {
    const { page } = ctx;

    // 1) OPEN — land on this morning's session (the live CC TUI), one tab.
    await ctx.idle(2600);
    await ctx.recordStep('opened — one session');

    // 2) COMPOSE — type a reply at human pace; the one-tap command chips
    //    (▶ cc) sit right above the Message box. We compose (don't Send: the
    //    capture runs a deterministic mock — see header). Bring the chip row
    //    into view so the "one tap to run a command" affordance reads.
    await page.locator('#input-text').focus();
    await ctx.typeCaption(PROMPT);
    await ctx.recordStep('reply composed');
    await page.evaluate(() => {
      const chip = [...document.querySelectorAll('button')]
        .find((b) => b.title === 'ccpc' || /▶\s*cc/.test(b.textContent || ''));
      if (chip) chip.scrollIntoView({ block: 'nearest', inline: 'start' });
    });
    await ctx.recordStep('quick-key chips visible');
    await ctx.idle(2000);

    // 3) NEW WORKSPACE — tap ＋ on the tab rail → the new-session menu (three
    //    ways: blank shell / shell + Claude Code / Claude Code in a project).
    await ctx.tap(() => document.getElementById('mcc-newtab-railbtn'));
    await ctx.idle(1900);
    await ctx.recordStep('new-session menu');

    // 4) CREATE — make a blank workspace; a second tab appears on the rail.
    await ctx.tap(() => [...document.querySelectorAll('button')].find((b) => /Blank tab/.test(b.textContent || '')));
    await ctx.idle(2600);
    await ctx.recordStep('second tab created');

    // 5) STATUS DOT — your morning session hits a permission prompt while you're
    //    on the new tab. Stage the seeded semantic event the daemon would emit;
    //    the tab pulses amber: "this one needs you". This is THE "which session
    //    wants me" beat.
    const firstPaneId = await page.evaluate((sess) => {
      const p = window.ttyview.listPanes().find((x) => x.session === sess);
      return p ? p.id : null;
    }, FIRST);
    if (!firstPaneId) throw new Error(`could not resolve pane id for ${FIRST}`);
    await page.evaluate((pid) => {
      // Same shape the core relays from a daemon 'semantic' WS event — drives
      // ttyview-tabs' waiting (amber) dot.
      window.ttyview._internal.emit('semantic', { pane: pid, name: 'claude.permission_prompt' });
    }, firstPaneId);
    await ctx.idle(2400);
    await ctx.recordStep('needs-you dot (amber)');

    // 6) JUMP — tap the pulsing tab to land on the session that needs you.
    await ctx.tap(() => { const d = [...document.querySelectorAll('.mcc-tabmenu-btn[data-session="api-claude1"]')].find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.top < window.innerHeight; }); return d ? d.closest('.ttvtab') : null; });
    await ctx.idle(2400);
    await ctx.recordStep('jumped to the session that needs you');
    // Poster: the CC session back in view + its amber "needs you" dot on the
    // tab + the multi-tab rail — the story in one frame.
    await ctx.stillSnapshot('hero-still');

    // 7) FIND — open the pane picker (Recent + project groups + ＋ New): the way
    //    to reach any session, then close it and settle.
    await page.evaluate(() => window.ttyview.openPanePicker());
    await ctx.idle(2400);
    await ctx.recordStep('pane picker — find any session');
    await page.evaluate(() => window.ttyview.closePanePicker());
    await ctx.idle(2600);
    await ctx.recordStep('settled');
  },

  validate: async (ctx) => {
    const { page } = ctx;
    // The live CC TUI rendered (not a blank pane).
    const chars = await page.evaluate(() => {
      const host = document.getElementById('grid-host');
      return host ? host.textContent.replace(/\s+/g, '').length : 0;
    });
    if (chars < 20) throw new Error(`expected a rendered terminal grid; got ${chars} non-space chars`);

    // The reply is composed in the Message box.
    const typed = await page.locator('#input-text').inputValue();
    if (!typed.includes(PROMPT)) {
      throw new Error(`expected composed reply in the Message box; got ${JSON.stringify(typed)}`);
    }

    // One-tap command chip (▶ cc) is present above the box.
    const hasChip = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => b.title === 'ccpc' || /▶\s*cc/.test(b.textContent || ''))
    );
    if (!hasChip) throw new Error('expected the ▶ cc one-tap command chip to be present');

    // A second session was created from the menu.
    const sessions = await page.evaluate(() => window.ttyview.listPanes().map((p) => p.session));
    if (!sessions.includes('tab')) {
      throw new Error(`expected a new 'tab' session after create; got ${JSON.stringify(sessions)}`);
    }

    // The "needs you" amber dot is showing for the morning session.
    const hasWaitingDot = await page.evaluate(() => !!document.querySelector('.ttvtab-dot.waiting'));
    if (!hasWaitingDot) throw new Error('expected an amber "waiting" status dot after the staged permission prompt');

    // We jumped to that session, and the picker closed cleanly.
    const state = await page.evaluate(() => ({
      active: window.ttyview.getActivePane()?.session,
      pickerOpen: !!document.querySelector('#pane-picker-overlay.open'),
    }));
    if (state.active !== FIRST) throw new Error(`expected active ${FIRST} after the jump; got ${JSON.stringify(state.active)}`);
    if (state.pickerOpen) throw new Error('pane picker should be closed at the end');
  },
};
