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

    // Tap the docs project's tab. The rail lives in a fixed bottom bar that
    // Playwright's click actionability refuses to "scroll into view", so we
    // dispatch the pointer sequence directly on the tab element — this fires
    // the tab plugin's real touch handler (pointerup) the same way a tap does.
    await ctx.page.evaluate(() => {
      const el = [...document.querySelectorAll('.pp-item')]
        .find((e) => /docs-claude1/.test(e.textContent || ''));
      if (!el) throw new Error('docs-claude1 tab not found in the rail');
      el.scrollIntoView({ block: 'center' });
      for (const type of ['pointerdown', 'pointerup']) {
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
      }
      el.click();
    });
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
