// new-session — the "no tmux knowledge required" scenario. Tap the ＋ on the
// tab rail to open the new-session menu (three ways: a bare shell · a shell
// with Claude Code · Claude Code in a project folder), then create a bare
// shell — a new tab appears, no `tmux new`, no Ctrl-b.

/** @type {import('../lib/workflow.mjs').Workflow} */
export default {
  id: 'new-session',
  title: 'Start a session from a button',
  description:
    "Tap ＋ on the tab rail → the new-session menu offers three ways to spin " +
    "one up (bare shell · shell with Claude Code · Claude Code in a project). " +
    "Make a bare shell; a new tab appears. You never learn tmux.",

  run: async (ctx) => {
    await ctx.idle(1400);
    await ctx.recordStep('tab rail');

    // Tap the ＋ rail button (pointer sequence — it's in the fixed bottom bar).
    await ctx.page.evaluate(() => {
      const b = document.getElementById('mcc-newtab-railbtn');
      if (!b) throw new Error('new-tab rail button not found');
      for (const t of ['pointerdown', 'pointerup']) {
        b.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true }));
      }
      b.click();
    });
    await ctx.idle(1200);
    await ctx.recordStep('new-session menu');

    // Hero still — the three creation options.
    await ctx.stillSnapshot('hero-still');

    // Create a bare shell (the menu option is a <button>).
    await ctx.page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /Blank tab/.test(b.textContent || ''));
      if (!btn) throw new Error('"Blank tab" option not found');
      for (const t of ['pointerdown', 'pointerup']) {
        btn.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true }));
      }
      btn.click();
    });
    await ctx.idle(2000);
    await ctx.recordStep('blank session created');
  },

  validate: async (ctx) => {
    // A new bare-shell session (named "tab") should now exist.
    const sessions = await ctx.page.evaluate(() => window.ttyview.listPanes().map((p) => p.session));
    if (!sessions.includes('tab')) {
      throw new Error(`expected a new 'tab' session after create; got ${JSON.stringify(sessions)}`);
    }
  },
};
