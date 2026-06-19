// Renders the 4 PWA icons from icon-source.html via Playwright (Chromium).
// headless-chrome --screenshot distorts SVGs vertically; use this instead.
//   node render-icons.mjs   (run from this dir; needs playwright on NODE_PATH)
import pw from '/home/eyalev/projects/personal/2026-05/ttyview/node_modules/playwright/index.js';
const { chromium } = pw;
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = 'file://' + join(here, 'icon-source.html');

const variants = [
  { file: 'icon-192.png', size: 192, maskable: 0 },
  { file: 'icon-512.png', size: 512, maskable: 0 },
  { file: 'icon-192-maskable.png', size: 192, maskable: 1 },
  { file: 'icon-512-maskable.png', size: 512, maskable: 1 },
];

const browser = await chromium.launch();
for (const v of variants) {
  const page = await browser.newPage({ viewport: { width: v.size, height: v.size }, deviceScaleFactor: 1 });
  await page.goto(`${src}?size=${v.size}&maskable=${v.maskable}`);
  const el = await page.$('#icon');
  await el.screenshot({ path: join(here, v.file), omitBackground: false });
  await page.close();
  console.log('wrote', v.file);
}
await browser.close();
