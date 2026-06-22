// pane-picker — the "find the session you want" scenario. Open the pane
// picker (the full-screen chooser with a Recent section + project groups + a
// ＋ New session button), then pick a session from it. This is the discovery
// surface for when you have more sessions than fit the tab rail.

/** @type {import('../lib/workflow.mjs').Workflow} */
export default {
  id: 'pane-picker',
  title: 'Pick a session from the picker',
  description:
    "Open the pane picker — a tap-friendly chooser listing every session by " +
    "project, with a Recent section and a ＋ New session button — and jump to " +
    "one. The way to reach a session that isn't a pinned tab.",

  run: async (ctx) => {
    await ctx.idle(1400);
    await ctx.recordStep('session view');

    // Open the picker (same effect as tapping the picker-open control).
    await ctx.page.evaluate(() => window.ttyview.openPanePicker());
    await ctx.idle(1400);
    await ctx.recordStep('picker open');

    // Hero still — the chooser with Recent + project groups.
    await ctx.stillSnapshot('hero-still');

    // Pick the docs session from within the picker (pointer sequence on the
    // matching entry, robust against fixed-overlay actionability checks).
    await ctx.page.evaluate(() => {
      const root = document.querySelector('#pane-picker-overlay');
      const el = [...root.querySelectorAll('*')]
        .find((e) => e.children.length === 0 && /docs-claude1/.test(e.textContent || ''));
      const target = el ? el.closest('[data-pane-id],li,button,[role=option],[class*=item]') || el : null;
      if (!target) throw new Error('docs-claude1 entry not found in picker');
      target.scrollIntoView({ block: 'center' });
      for (const type of ['pointerdown', 'pointerup']) {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
      }
      target.click();
    });
    await ctx.recordStep('picked docs-claude1');
    await ctx.idle(1600);
    await ctx.recordStep('on docs-claude1');
  },

  validate: async (ctx) => {
    // Picker should have closed and the picked session be active.
    const state = await ctx.page.evaluate(() => ({
      active: window.ttyview.getActivePane()?.session,
      pickerOpen: !!document.querySelector('#pane-picker-overlay.open'),
    }));
    if (state.active !== 'docs-claude1') {
      throw new Error(`expected docs-claude1 active after picking; got ${JSON.stringify(state.active)}`);
    }
    if (state.pickerOpen) throw new Error('picker should close after a selection');
  },
};
