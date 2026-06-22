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

// Prompt composed in the Message box. We deliberately do NOT press Send: the
// capture runs against a deterministic mock CC session (no real Anthropic
// token — see demos/CONVENTIONS.md "Determinism"), so sending would dump the
// text into the underlying shell instead of a real CC turn. The README's own
// pitch is "you type replies in the box at the bottom" — composing a reply on
// top of a live session is exactly that shot. A real-token "watch CC respond"
// clip is a separate future workflow.
const PROMPT =
  process.env.USE_FLOW_PROMPT || 'add unit tests for the debounce, including maxWait';

/** @type {import('../lib/workflow.mjs').Workflow} */
export default {
  id: 'use-flow',
  title: 'Drive a Claude Code session from your phone',
  description:
    "The real Claude Code TUI rendered live in the browser — auto-fit to the " +
    "phone, the quick-keys row above the keyboard, and a reply being typed in " +
    "the Message box. The answer to 'what does driving CC from my phone look " +
    "like?'.",

  run: async (ctx) => {
    // Settle so the eye lands on the live session (the rendered CC TUI).
    await ctx.idle(1800);
    await ctx.recordStep('session visible');

    // Type a reply at human pace into the Message box.
    await ctx.page.locator('#input-text').focus();
    await ctx.typeCaption(PROMPT);
    await ctx.recordStep('reply typed');
    await ctx.idle(700);

    // Hero still — CC TUI above, quick-keys row, reply composed in the box.
    await ctx.stillSnapshot('hero-still');

    // Hold on the composed state — the most screenshotable moment.
    await ctx.idle(1800);
    await ctx.recordStep('composed');
  },

  validate: async (ctx) => {
    // The reply should be sitting in the Message box, composed and ready.
    const typed = await ctx.page.locator('#input-text').inputValue();
    if (!typed.includes(PROMPT)) {
      throw new Error(
        `expected the Message box to hold the composed reply; got: ${JSON.stringify(typed)}`
      );
    }
    // The terminal grid should have rendered real content (the live CC TUI is
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
