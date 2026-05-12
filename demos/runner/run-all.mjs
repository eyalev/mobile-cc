// run-all.mjs — iterate every workflow under workflows/, drive it
// through the capture pipeline, generate dist/demos/{id}/* outputs
// plus a top-level dist/demos/index.html landing.
//
// Exit codes:
//   0 — every workflow's run + validate succeeded
//   1 — at least one workflow failed (run threw or validate threw)

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { setupCapture } from '../lib/capture.mjs';

const here     = dirname(fileURLToPath(import.meta.url));
const root     = resolve(here, '..');
const wfDir    = resolve(root, 'workflows');
const siteDir  = resolve(root, 'site');
const dist     = resolve(root, 'dist');
const distDemo = resolve(dist, 'demos');

const DAEMON_URL = process.env.MOBILE_CC_URL || 'https://127.0.0.1:7800/';
const PANE_ID    = process.env.TTV_PANE      || '%6';
const VERSION    = readMobileCcVersion();

mkdirSync(distDemo, { recursive: true });

const workflowFiles = readdirSync(wfDir).filter(f => f.endsWith('.mjs'));
console.log(`[runner] ${workflowFiles.length} workflow(s); daemon=${DAEMON_URL}; pane=${PANE_ID}; version=${VERSION}`);

const summaries = [];
let anyFailed = false;

for (const f of workflowFiles) {
  const path = join(wfDir, f);
  console.log(`\n[runner] === ${f} ===`);
  const mod = (await import(path)).default;
  if (!mod || typeof mod !== 'object' || typeof mod.run !== 'function') {
    console.error(`  skipping ${f} — default export missing { id, run }`);
    continue;
  }
  const outDir = resolve(distDemo, mod.id);
  const cap = await setupCapture({ daemonUrl: DAEMON_URL, paneId: PANE_ID, outDir });
  const ctx = cap.makeWorkflowCtx();
  let runError = null;
  try {
    await mod.run(ctx);
  } catch (e) {
    runError = e;
    console.error(`  run() threw: ${e.message}`);
  }
  let validateError = null;
  if (!runError && typeof mod.validate === 'function') {
    try {
      await mod.validate(ctx);
    } catch (e) {
      validateError = e;
      console.error(`  validate() threw: ${e.message}`);
    }
  }
  const stepsJson = await cap.finalize({
    workflowId: mod.id,
    validation: validateError ? 'failed' : 'passed',
    error: runError || validateError,
    version: VERSION,
  });
  // Per-workflow HTML page (uses the site template).
  writePerWorkflowHtml({ workflow: mod, steps: stepsJson, outDir });

  summaries.push({
    id: mod.id, title: mod.title, description: mod.description,
    validation: stepsJson.validation, error: stepsJson.error,
    duration_ms: stepsJson.duration_ms,
  });
  if (runError || validateError) anyFailed = true;
}

// Landing page.
writeIndexHtml({ summaries, version: VERSION });

console.log(`\n[runner] ${summaries.length} workflow(s); ${summaries.filter(s => s.validation === 'passed').length} passed; ${anyFailed ? 'FAILURES present' : 'all pass'}`);
console.log(`[runner] output: ${distDemo}`);
process.exit(anyFailed ? 1 : 0);

// --- helpers --------------------------------------------------------------

function readMobileCcVersion() {
  // Parse top-level Cargo.toml for the package version. Cheap, no toml
  // dep — the workspace root is two levels up from this file.
  const cargoTomlPath = resolve(root, '..', 'Cargo.toml');
  if (!existsSync(cargoTomlPath)) return 'unknown';
  const body = readFileSync(cargoTomlPath, 'utf8');
  const m = body.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : 'unknown';
}

function writePerWorkflowHtml({ workflow, steps, outDir }) {
  const tpl = readFileSync(resolve(siteDir, 'workflow.html'), 'utf8');
  const html = tpl
    .replace(/\{\{TITLE\}\}/g, escapeHtml(workflow.title))
    .replace(/\{\{ID\}\}/g, workflow.id)
    .replace(/\{\{DESCRIPTION\}\}/g, escapeHtml(workflow.description))
    .replace(/\{\{VERSION\}\}/g, escapeHtml(steps.version))
    .replace(/\{\{VALIDATION\}\}/g, steps.validation)
    .replace(/\{\{DURATION\}\}/g, String(Math.round(steps.duration_ms / 100) / 10))
    .replace(/\{\{STEPS_JSON\}\}/g, JSON.stringify(steps.steps));
  writeFileSync(join(outDir, 'index.html'), html);
}

function writeIndexHtml({ summaries, version }) {
  const tpl = readFileSync(resolve(siteDir, 'index.html'), 'utf8');
  const cards = summaries.map(s => `
    <a class="card" href="${s.id}/">
      <div class="thumb"><img src="${s.id}/hero.gif" alt="${escapeHtml(s.title)} hero" loading="lazy"></div>
      <div class="meta">
        <h3>${escapeHtml(s.title)}</h3>
        <p>${escapeHtml(s.description)}</p>
        <p class="badges">
          <span class="badge badge-${s.validation}">${s.validation}</span>
          <span class="badge">${Math.round(s.duration_ms / 100) / 10}s</span>
        </p>
      </div>
    </a>`).join('\n');
  const html = tpl
    .replace(/\{\{VERSION\}\}/g, escapeHtml(version))
    .replace(/\{\{CARDS\}\}/g, cards)
    .replace(/\{\{COUNT\}\}/g, String(summaries.length));
  writeFileSync(resolve(distDemo, 'index.html'), html);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
