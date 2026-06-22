// chat-view — the "read back a long session on your phone" scenario. Switch
// from the live terminal (cell-grid) to the chat-style transcript reader
// (ttyview-cc), which renders the session's JSONL conversation as clean,
// scrollable chat bubbles.
//
// NOTE: this switches via the internal terminal-view API
// (`_internal.setActiveTerminalViewId`) because the current build ships NO
// user-facing control for it — see the demos evaluation / the open UX issue.
// The workflow doubles as a regression test that the chat reader still
// renders even though its button is missing.

/** @type {import('../lib/workflow.mjs').Workflow} */
export default {
  id: 'chat-view',
  title: 'Read the session as a chat transcript',
  description:
    "Flip from the live terminal to the chat-style transcript reader — the " +
    "conversation rendered as scrollable bubbles from the JSONL on disk. The " +
    "way to read back a long session on a phone without squinting at the TUI.",

  run: async (ctx) => {
    await ctx.idle(1500);
    await ctx.recordStep('terminal view');

    // Switch to the chat reader.
    await ctx.page.evaluate(() => window.ttyview._internal.setActiveTerminalViewId('ttyview-cc'));
    await ctx.idle(1500);
    await ctx.recordStep('chat reader');

    // Hero still — the transcript rendered as chat.
    await ctx.stillSnapshot('hero-still');

    // Gentle scroll to show it's a scrollable reader.
    await ctx.page.evaluate(() => {
      const h = document.getElementById('grid-host');
      if (h) h.scrollTop = Math.max(0, h.scrollHeight - h.clientHeight);
    });
    await ctx.idle(1600);
    await ctx.recordStep('scrolled the transcript');
  },

  validate: async (ctx) => {
    const s = await ctx.page.evaluate(() => ({
      view: window.ttyview._internal.getActiveTerminalViewId(),
      chars: (document.getElementById('grid-host')?.textContent || '').replace(/\s+/g, '').length,
    }));
    if (s.view !== 'ttyview-cc') {
      throw new Error(`expected active view ttyview-cc; got ${JSON.stringify(s.view)}`);
    }
    if (s.chars < 200) {
      throw new Error(`expected a rendered transcript; got ${s.chars} non-space chars`);
    }
  },
};
