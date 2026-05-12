// paste-flow — the hero workflow. Paste a screenshot, type a caption,
// press Send. Daemon paste-buffers `caption [image: /abs/path]` into
// the CC pane; CC's vision pipeline reads the file. Three plugins
// exercised: ttyview-image-paste, ttyview-quickkeys (visible in the
// accessory row), and ttyview-cc (the chat view is rendered by it
// indirectly via the underlying tmux pane).
//
// Pre-flight assertions in setup() will fail loudly if the running
// daemon doesn't have ttyview-image-paste installed — that's the
// "the workflow is broken" signal.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Fixture screenshot shipped under demos/fixtures/. Synthetic, no
// real content. Override via PASTE_FLOW_IMAGE if you really need to.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT = process.env.PASTE_FLOW_IMAGE
  || resolve(HERE, '../fixtures/paste-screenshot.png');

const CAPTION = 'does the tooltip auto-hide after 2s here?';

/** @type {import('../lib/workflow.mjs').Workflow} */
export default {
  id: 'paste-flow',
  title: 'Image paste end-to-end',
  description:
    "Paste a screenshot into the Message box → it uploads to the daemon → " +
    "on Send, the daemon paste-buffers `<caption> [image: /abs/path]` into " +
    "the tmux pane and Claude Code's vision pipeline reads the file. The " +
    "answer to 'how do I get a screenshot into Claude over SSH?'.",

  run: async (ctx) => {
    // Hold so the eye settles on the initial UI.
    await ctx.idle(1500);
    await ctx.recordStep('idle');

    // Dispatch the paste. Plugin uploads via XHR; thumbnail renders
    // in the preview row above the input.
    await ctx.dispatchPaste(SCREENSHOT);
    await ctx.recordStep('paste dispatched');
    await ctx.idle(900);
    await ctx.recordStep('thumbnail rendered');

    // Type the caption at human pace.
    await ctx.page.locator('#input-text').focus();
    await ctx.typeCaption(CAPTION);
    await ctx.recordStep('caption typed');
    await ctx.idle(700);

    // Hero still — thumb in preview row + caption typed + Send
    // highlighted. The most-screenshotable moment of the loop.
    await ctx.stillSnapshot('hero-still');

    // Send. The plugin intercepts via capture-phase, fires
    // /api/uploads/send; daemon paste-buffers into the CC pane +
    // verify-retry Enter.
    await ctx.pressSend();
    await ctx.recordStep('send pressed');
    await ctx.idle(400);

    // After-state: thumb clears, textarea clears, CC's TUI receives
    // the pasted message and starts processing.
    await ctx.idle(2200);
    await ctx.recordStep('cc ingested');
  },

  validate: async (ctx) => {
    // The textarea should be empty after Send (plugin clears it on
    // 200). If it isn't, either Send didn't fire or the cleanup path
    // is broken.
    const remaining = await ctx.page.locator('#input-text').inputValue();
    if (remaining.trim()) {
      throw new Error(
        `expected textarea cleared after Send; still has: ${JSON.stringify(remaining)}`
      );
    }
    // The thumbnail preview row should be empty (no <img> children
    // inside #ttv-img-preview or it should be display:none).
    const thumbCount = await ctx.page.evaluate(() => {
      const el = document.getElementById('ttv-img-preview');
      if (!el) return 0;
      if (el.style.display === 'none') return 0;
      return el.querySelectorAll('.ttv-img-thumb').length;
    });
    if (thumbCount > 0) {
      throw new Error(`expected preview row empty after Send; ${thumbCount} thumb(s) remain`);
    }
  },
};
