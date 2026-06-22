// Shared Playwright + ffmpeg helpers used by the runner.
//
// What this module owns:
//   - browser/context lifecycle (Pixel-7 viewport, 3× DPR → native-res
//     recording, ignoreHTTPSErrors)
//   - recordVideo → WebM, ffmpeg → MP4 (H.264) + GIF (15 fps, 256-color
//     palette, Floyd-Steinberg dither — no banding)
//   - WorkflowCtx implementation (idle / recordStep / dispatchPaste /
//     typeCaption / pressSend / stillSnapshot)
//   - per-workflow output dir layout

import { chromium, devices } from 'playwright';
import { readFileSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// --- Capture standard (single source of truth — see demos/CONVENTIONS.md) ---
//
// NATIVE-RESOLUTION FLOOR. Record at viewport × DPR so GitHub never has to
// upscale the embedded player. The blurry 300px-wide use.mp4 was caused by
// violating exactly this: a sub-native source stretched to fill the README
// column on a 3×-DPR phone. 412×915 is a real phone CSS viewport; ×3 DPR
// yields a 1236-wide capture, comfortably above the MIN_WIDTH gate in
// demos/check.mjs. Bump DPR (not the CSS viewport) to go sharper — that keeps
// the real mobile layout while raising pixel density.
const DPR = 3;

const VIEW = {
  ...devices['Pixel 7'],
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: DPR,
};

// Video frame size = device pixels (CSS viewport × DPR). Playwright scales the
// rendered frames to this; matching it to the backing buffer = 1:1, crisp.
const RECORD_SIZE = {
  width: VIEW.viewport.width * DPR,
  height: VIEW.viewport.height * DPR,
};

/**
 * Spin a browser + context + page wired up for one workflow capture.
 * Returns { browser, ctx, page, makeWorkflowCtx } — caller drives the
 * workflow then closes browser to finalise the video.
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
    recordVideo: {
      dir: outDir,
      size: RECORD_SIZE,
    },
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
      await ctx.close();
      await browser.close();

      // Find Playwright's auto-named .webm and rename.
      const webm = readdirSync(outDir).find(f => f.endsWith('.webm'));
      if (!webm) throw new Error('no .webm produced by recordVideo');
      const webmPath = resolve(outDir, 'hero.webm');
      renameSync(resolve(outDir, webm), webmPath);

      // Trim 1 s of leading blank (recordVideo begins before the page
      // has painted), produce hero.mp4 + hero.gif.
      const mp4Path = resolve(outDir, 'hero.mp4');
      const trimmedWebm = resolve(outDir, '_trimmed.webm');
      runFfmpeg(['-y', '-ss', '1.0', '-i', webmPath, '-c', 'copy', trimmedWebm]);
      // Replace the un-trimmed webm with the trimmed one for downstream consumers.
      renameSync(trimmedWebm, webmPath);

      // MP4 (H.264 baseline-ish, yuv420p for broad support, faststart for
      // streaming). No audio.
      runFfmpeg([
        '-y', '-i', webmPath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '22',
        '-movflags', '+faststart', '-an',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        mp4Path,
      ]);

      // GIF: extract frames at 15 fps, generate a 256-color palette
      // from the full clip, encode with Floyd-Steinberg dither. Avoids
      // the banding ffmpeg's default paletteuse produces on dark
      // screenshot content.
      const framesDir = resolve(outDir, '_frames');
      mkdirSync(framesDir, { recursive: true });
      runFfmpeg(['-y', '-i', mp4Path, '-vf', 'fps=15', join(framesDir, 'f-%03d.png')]);
      const palette = resolve(framesDir, '_palette.png');
      runFfmpeg([
        '-y', '-i', join(framesDir, 'f-%03d.png'),
        '-vf', 'palettegen=max_colors=256:stats_mode=full',
        palette,
      ]);
      runFfmpeg([
        '-y', '-framerate', '15', '-i', join(framesDir, 'f-%03d.png'),
        '-i', palette,
        '-lavfi', 'paletteuse=dither=floyd_steinberg',
        resolve(outDir, 'hero.gif'),
      ]);
      // Cleanup frames dir; not useful downstream.
      rmSync(framesDir, { recursive: true, force: true });

      // steps.json — the test-signal + the timeline annotation.
      const stepsJson = {
        id: workflowId,
        version,
        startedAt: new Date(t0).toISOString(),
        duration_ms: Date.now() - t0,
        steps,
        validation: error ? 'failed' : (validation ?? 'passed'),
        error: error ? String(error.message || error) : null,
        assets: {
          video_mp4: 'hero.mp4',
          video_webm: 'hero.webm',
          gif: 'hero.gif',
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
