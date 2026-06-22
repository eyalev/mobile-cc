// Render the native-app icon variant (coral) → 1024px PNGs for
// @capacitor/assets: icon-only (full), icon-foreground (card, transparent),
// icon-background (gradient). Playwright/Chromium — headless-chrome
// --screenshot distorts SVGs, so we use Playwright element.screenshot.
import pw from '/home/eyalev/projects/personal/2026-05/ttyview/node_modules/playwright/index.js';
const { chromium } = pw;
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = 'file://' + join(here, 'icon-native.html');
const out = join(here, '..', 'assets');

const variants = [
  { file: 'icon-only.png', mode: 'full', omitBackground: false },
  { file: 'icon-background.png', mode: 'bg', omitBackground: false },
  { file: 'icon-foreground.png', mode: 'fg', omitBackground: true },
];

const browser = await chromium.launch();
for (const v of variants) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.goto(`${src}?size=1024&mode=${v.mode}`);
  const el = await page.$('#icon');
  await el.screenshot({ path: join(out, v.file), omitBackground: v.omitBackground });
  await page.close();
  console.log('wrote', v.file);
}
await browser.close();
