// use-flow — the hero "See it" clip. Show the real Claude Code TUI rendered
// live: settle on a session, type a short prompt in the Message box, press
// Send, and let Claude Code start working. This is the README "See it" video
// (docs/media/use.{mp4,gif,png}).
//
// Regenerate sharp with:
//   demos/run.sh use-flow
// against a daemon whose capture pane (TTV_PANE) runs a seeded Claude Code
// session — see demos/CONVENTIONS.md "Determinism". Capture resolution is the
// shared native-res standard in lib/capture.mjs (no per-workflow tuning).

const PROMPT =
  process.env.USE_FLOW_PROMPT || 'add a --version flag that prints the build date';

/** @type {import('../lib/workflow.mjs').Workflow} */
export default {
  id: 'use-flow',
  title: 'Drive a live Claude Code session',
  description:
    "The real Claude Code TUI, rendered live in the browser — quick-keys row, " +
    "type a prompt in the Message box, Send, and watch Claude Code start " +
    "working. The answer to 'what does driving CC from my phone look like?'.",

  run: async (ctx) => {
    // Settle so the eye lands on the live session.
    await ctx.idle(1800);
    await ctx.recordStep('session visible');

    // Type a prompt at human pace.
    await ctx.page.locator('#input-text').focus();
    await ctx.typeCaption(PROMPT);
    await ctx.recordStep('prompt typed');
    await ctx.idle(600);

    // Hero still — prompt typed, quick-keys row visible, Send highlighted.
    await ctx.stillSnapshot('hero-still');

    // Send it; Claude Code receives the line and starts processing.
    await ctx.pressSend();
    await ctx.recordStep('send pressed');

    // Hold while CC's TUI churns — the payoff shot.
    await ctx.idle(3500);
    await ctx.recordStep('cc working');
  },

  validate: async (ctx) => {
    // The Message box should clear after Send.
    const remaining = await ctx.page.locator('#input-text').inputValue();
    if (remaining.trim()) {
      throw new Error(
        `expected Message box cleared after Send; still has: ${JSON.stringify(remaining)}`
      );
    }
    // The terminal grid should have rendered real content (the live TUI is
    // present, not a blank pane).
    const chars = await ctx.page.evaluate(() => {
      const host = document.getElementById('grid-host');
      return host ? host.textContent.replace(/\s+/g, '').length : 0;
    });
    if (chars < 20) {
      throw new Error(`expected a rendered terminal grid; got ${chars} non-space chars`);
    }
  },
};
