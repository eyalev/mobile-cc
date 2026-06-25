// Shared Playwright + ffmpeg helpers used by the runner.
//
// What this module owns:
//   - browser/context lifecycle (Pixel-7 viewport, 3× DPR, ignoreHTTPSErrors)
//   - DEVICE-RESOLUTION capture via CDP screencast → ffmpeg → MP4 (H.264) + GIF
//   - WorkflowCtx implementation (idle / recordStep / dispatchPaste /
//     typeCaption / pressSend / stillSnapshot)
//   - per-workflow output dir layout
//
// Why a page.screenshot FILMSTRIP and not recordVideo / screencast:
//   Both Playwright recordVideo AND CDP Page.startScreencast capture at the
//   CSS-VIEWPORT resolution and ignore deviceScaleFactor — a 412-CSS phone
//   yields only 412-wide frames (recordVideo additionally PADS into a corner
//   if you ask for a bigger size: the gray-void bug). The ONLY capture path
//   that honours DPR is CDP Page.captureScreenshot (what page.screenshot
//   wraps): a 412×915 viewport at DPR 3 → sharp 1236-wide PNGs. So we grab a
//   filmstrip of device-resolution screenshots on a timer during the run and
//   assemble them with real per-frame timings.

import { chromium, devices } from 'playwright';
import { readFileSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// --- Capture standard (single source of truth — see demos/CONVENTIONS.md) ---
//
// Real phone CSS viewport (412×915) at DPR 3 → device-pixel frames ~1236 wide.
// Bump DPR to go sharper; that keeps the mobile layout and raises pixel
// density. Output fps is fixed so the mp4 is CFR (broad player compatibility).
const DPR = 3;
const OUT_FPS = 30;

const VIEW = {
  ...devices['Pixel 7'],
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: DPR,
};

/**
 * Spin a browser + context + page wired up for one workflow capture.
 * Returns { browser, ctx, page, makeWorkflowCtx } — caller drives the
 * workflow then calls finalize() to assemble the video.
 */
export async function setupCapture({ daemonUrl, paneId, outDir }) {
  mkdirSync(outDir, { recursive: true });
  // Wipe stale outputs so a re-run is clean.
  for (const f of readdirSync(outDir)) {
    try { rmSync(join(outDir, f)); } catch {}
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    ...VIEW,
    ignoreHTTPSErrors: true,
  });

  // Seed localStorage so the page boots on the demo pane, cell-grid
  // view, default theme — matching real Mobile CC.
  await ctx.addInitScript(([pane]) => {
    localStorage.setItem('ttv-last-pane-id', pane);
    localStorage.removeItem('ttv-active-view');
    localStorage.removeItem('ttv-active-theme');
  }, [paneId]);

  const page = await ctx.newPage();
  await page.goto(daemonUrl);
  await page.waitForLoadState('networkidle');

  // Device-resolution filmstrip: poll page.screenshot (~10 fps) during the run.
  // page.screenshot is the one capture path that honours deviceScaleFactor, so
  // a 412×915 viewport at DPR 3 → sharp 1236-wide frames. Each frame keeps a
  // wall-clock timestamp so finalize() reproduces real pacing.
  const frames = []; // { buf: Buffer, ts: number(seconds) }
  let capturing = true;
  const TARGET_MS = 90;
  const filmstrip = (async () => {
    while (capturing) {
      const start = Date.now();
      try {
        const buf = await page.screenshot({ type: 'png', animations: 'allow' });
        frames.push({ buf, ts: Date.now() / 1000 });
      } catch { /* page busy/teardown — skip this tick */ }
      const elapsed = Date.now() - start;
      if (elapsed < TARGET_MS) await new Promise((r) => setTimeout(r, TARGET_MS - elapsed));
    }
  })();

  const t0 = Date.now();
  const steps = [];

  /** Build a WorkflowCtx for the workflow's `run` / `validate`. */
  function makeWorkflowCtx() {
    return {
      page,
      idle: (ms) => page.waitForTimeout(ms),
      recordStep: async (label) => {
        steps.push({ t_ms: Date.now() - t0, label });
      },
      dispatchPaste: async (pngPath) => {
        const b64 = readFileSync(pngPath).toString('base64');
        await page.evaluate((bytes) => {
          const raw = atob(bytes);
          const arr = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          const blob = new Blob([arr], { type: 'image/png' });
          const file = new File([blob], 'paste.png', { type: 'image/png' });
          const dt = new DataTransfer();
          dt.items.add(file);
          const ta = document.getElementById('input-text');
          ta.focus();
          const ev = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(ev, 'clipboardData', { value: dt });
          ta.dispatchEvent(ev);
        }, b64);
      },
      typeCaption: (text, opts = {}) =>
        page.keyboard.type(text, { delay: opts.delay ?? 80 }),
      pressSend: () => page.locator('#send-btn').click(),
      stillSnapshot: (name) =>
        page.screenshot({ path: resolve(outDir, `${name}.png`) }),
    };
  }

  return {
    browser, ctx, page, makeWorkflowCtx, steps, t0,
    /** Call when the workflow's run() has returned. Finalises everything. */
    async finalize({ workflowId, validation, error, version }) {
      capturing = false;
      await filmstrip; // drain the in-flight screenshot
      await ctx.close();
      await browser.close();

      if (frames.length < 2) throw new Error(`filmstrip produced ${frames.length} frame(s)`);

      // Dump frames + build an ffconcat list with real per-frame durations.
      const framesDir = resolve(outDir, '_frames');
      mkdirSync(framesDir, { recursive: true });
      const t0s = frames[0].ts;
      let concat = 'ffconcat version 1.0\n';
      frames.forEach((fr, i) => {
        const name = `f-${String(i).padStart(5, '0')}.png`;
        writeFileSync(join(framesDir, name), fr.buf);
        const next = frames[i + 1];
        // Last frame: hold ~1s on the final state.
        const dur = next ? Math.max(0.01, next.ts - fr.ts) : 1.0;
        concat += `file '${name}'\nduration ${dur.toFixed(3)}\n`;
      });
      // ffconcat quirk: repeat the last file so its duration is honoured.
      concat += `file 'f-${String(frames.length - 1).padStart(5, '0')}.png'\n`;
      const concatPath = join(framesDir, 'concat.txt');
      writeFileSync(concatPath, concat);

      // MP4 — resample the variable-rate frames to CFR OUT_FPS, even dims,
      // yuv420p + faststart for broad player support (GitHub/Safari/QuickTime).
      const mp4Path = resolve(outDir, 'hero.mp4');
      runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
        '-vf', `fps=${OUT_FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '22',
        '-movflags', '+faststart', '-an',
        mp4Path,
      ]);

      // NO GIF. We deliberately no longer emit a .gif — autoplaying GIFs are
      // bad UX (they start on their own and can't be paused). Committed media
      // is MP4 (+ poster PNG); GitHub renders an MP4 as an inline player WITH
      // controls when embedded via a user-attachments URL (see gen-gallery.mjs).
      rmSync(framesDir, { recursive: true, force: true });

      // steps.json — the test-signal + the timeline annotation.
      const stepsJson = {
        id: workflowId,
        version,
        startedAt: new Date(t0).toISOString(),
        duration_ms: Date.now() - t0,
        frames: frames.length,
        steps,
        validation: error ? 'failed' : (validation ?? 'passed'),
        error: error ? String(error.message || error) : null,
        assets: {
          video_mp4: 'hero.mp4',
          still: existsSync(resolve(outDir, 'hero-still.png')) ? 'hero-still.png' : null,
        },
      };
      writeFileSync(
        resolve(outDir, 'steps.json'),
        JSON.stringify(stepsJson, null, 2)
      );
      return stepsJson;
    },
  };
}

function runFfmpeg(args) {
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} → exit ${r.status}`);
}
