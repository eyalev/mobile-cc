// Re-captures the 4 README stills against the LIVE mobile-cc UI:
//   docs/media/hero.png      phone — terminal + project-grouped tabs
//   docs/media/sessions.png  phone — pane picker (sessions across projects)
//   docs/media/chat.png      phone — chat-style transcript reader (ttyview-cc)
//   docs/media/desktop.png   desktop — full-width session + tabs
//
// Phone stills use iPhone framing (393×851 @ DPR3 = 1179×2553, matching the
// originals); desktop is 1440×900. Run via demos/local-stills.sh, which stands
// up an isolated synthetic multi-project daemon (blue de-oranged UI) and passes
// MOBILE_CC_URL + TTV_PANE. This is the reproducible recipe these README stills
// previously lacked (they were ad-hoc captures — see demos/CONVENTIONS.md).
import pw from '/home/eyalev/projects/personal/2026-05/ttyview/node_modules/playwright/index.js';
const { chromium } = pw;
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const URL = process.env.MOBILE_CC_URL || 'http://127.0.0.1:7899/';
const PANE = process.env.TTV_PANE || '';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../docs/media');

const browser = await chromium.launch();

async function shoot(file, { width, height, dpr, prep, settle = 1400, verify }) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: dpr, ignoreHTTPSErrors: true,
  });
  // Boot on the demo pane, cell-grid view, default (dark) theme — matching the
  // original stills' framing.
  await ctx.addInitScript((p) => {
    if (p) localStorage.setItem('ttv-last-pane-id', p);
    localStorage.removeItem('ttv-active-view');
    localStorage.removeItem('ttv-active-theme');
  }, PANE);
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1600);
  if (prep) { await prep(page); await page.waitForTimeout(settle); }
  if (verify) {
    const ok = await verify(page);
    if (!ok) throw new Error(`verify failed for ${file}`);
  }
  await page.screenshot({ path: join(OUT, file) });
  await ctx.close();
  console.log('wrote', file);
}

const PHONE = { width: 393, height: 851, dpr: 3 };

// hero — the live terminal + project-grouped tab rail
await shoot('hero.png', { ...PHONE });
// sessions — the pane picker (Recent + project groups + New session)
await shoot('sessions.png', { ...PHONE, prep: (p) => p.evaluate(() => window.ttyview.openPanePicker()) });
// chat — the chat-style transcript reader (no UI control yet → internal API).
// Switching unmounts the cell-grid then fetches+renders the JSONL transcript,
// so wait for the reader to actually be active + populated before shooting.
await shoot('chat.png', {
  ...PHONE,
  prep: (p) => p.evaluate(() => window.ttyview._internal.setActiveTerminalViewId('ttyview-cc')),
  settle: 3000,
  verify: (p) => p.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      const view = window.ttyview._internal.getActiveTerminalViewId();
      const chars = (document.getElementById('grid-host')?.textContent || '').replace(/\s+/g, '').length;
      if (view === 'ttyview-cc' && chars > 200) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }),
});
// desktop — wide browser, full-width session + tabs
await shoot('desktop.png', { width: 1440, height: 900, dpr: 1 });

await browser.close();
console.log('README stills regenerated → docs/media/{hero,sessions,chat,desktop}.png');
