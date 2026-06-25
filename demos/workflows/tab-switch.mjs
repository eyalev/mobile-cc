// tab-switch — the "juggle every project from one screen" scenario. Start on
// an api session, tap the docs project's tab, land on it. Exercises the
// project-grouped tab rail (multi-project profile) and the one-tap switch that
// is mobile-cc's core navigation.

/** @type {import('../lib/workflow.mjs').Workflow} */
export default {
  id: 'tab-switch',
  title: 'Switch projects with one tap',
  description:
    "The project-grouped tab rail in action: you're in the api project, tap " +
    "the docs project's tab, and you're there — no tmux, no Ctrl-b. The answer " +
    "to 'how do I jump between repos from my phone?'.",

  run: async (ctx) => {
    // Settle on the starting (api) session.
    await ctx.idle(1600);
    await ctx.recordStep('on api-claude1');

    // Hero still — the multi-project rail before switching.
    await ctx.stillSnapshot('hero-still');

    // Tap the docs project's VISIBLE rail tab. The rail tab is a .ttvtab; we
    // find it via its on-screen ⋮ (button.mcc-tabmenu-btn[data-session=…]) so
    // the marker lands on the visible tab (a bare `.pp-item` text match can
    // resolve an off-screen recents entry). ctx.tap marks + fires the real tap.
    await ctx.tap(() => { const d = [...document.querySelectorAll('.mcc-tabmenu-btn[data-session="docs-claude1"]')].find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.top < window.innerHeight; }); return d ? d.closest('.ttvtab') : null; });
    await ctx.recordStep('tapped docs tab');

    // Hold on the switched-to session.
    await ctx.idle(2000);
    await ctx.recordStep('on docs-claude1');
  },

  validate: async (ctx) => {
    const active = await ctx.page.evaluate(() => window.ttyview.getActivePane()?.session);
    if (active !== 'docs-claude1') {
      throw new Error(`expected active session docs-claude1 after tap; got ${JSON.stringify(active)}`);
    }
  },
};
