#!/usr/bin/env node
// Demos consistency gate — runs in CI WITHOUT a daemon. It does not capture;
// it asserts the demos system is internally consistent and that committed
// media meets the standard. This is what catches the "blurry use.mp4" class
// of regression before it ships. See demos/CONVENTIONS.md.
//
// Checks:
//   - every manifest demo has its recipe (workflows/<id>.mjs or terminal/<id>.sh)
//   - ui workflows default-export { id, run } and the id matches the manifest
//   - every demo that declares `media` has docs/media/<media>.{mp4,gif}
//   - each such mp4 is >= min_video_width px (recapture_pending -> warning)
//   - each demo's attachment_url is actually referenced in README.md
//   - no orphan recipes (a workflow/terminal file with no manifest entry)
//
// Exit 0 = clean (warnings allowed); exit 1 = at least one error.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRaw, DEMOS_DIR, MEDIA_DIR, ROOT } from './lib/manifest.mjs';

const errors = [];
const warns = [];

const raw = loadRaw();
const MIN_W = raw.min_video_width ?? 700;
const demos = raw.demos;
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

function probeWidth(file) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  return parseInt((r.stdout || '').trim(), 10) || 0;
}

const seen = new Set();
for (const d of demos) {
  if (seen.has(d.id)) errors.push(`duplicate demo id: ${d.id}`);
  seen.add(d.id);

  // Recipe present + well-formed.
  if (d.kind === 'ui') {
    const wf = join(DEMOS_DIR, 'workflows', `${d.id}.mjs`);
    if (!existsSync(wf)) {
      errors.push(`${d.id}: ui demo missing workflows/${d.id}.mjs`);
    } else {
      const mod = (await import(wf)).default;
      if (!mod || typeof mod.run !== 'function') errors.push(`${d.id}: workflow default export missing run()`);
      else if (mod.id !== d.id) errors.push(`${d.id}: workflow id mismatch (export says "${mod.id}")`);
    }
  } else if (d.kind === 'terminal') {
    if (!existsSync(join(DEMOS_DIR, 'terminal', `${d.id}.sh`))) {
      errors.push(`${d.id}: terminal demo missing terminal/${d.id}.sh`);
    }
  } else {
    errors.push(`${d.id}: unknown kind "${d.kind}"`);
  }

  // Committed media + resolution floor (only for demos that publish).
  if (d.media) {
    for (const ext of ['mp4', 'gif']) {
      if (!existsSync(join(MEDIA_DIR, `${d.media}.${ext}`))) {
        errors.push(`${d.id}: missing docs/media/${d.media}.${ext}`);
      }
    }
    const mp4 = join(MEDIA_DIR, `${d.media}.mp4`);
    if (existsSync(mp4)) {
      const w = probeWidth(mp4);
      if (w && w < MIN_W) {
        const msg = `${d.id}: docs/media/${d.media}.mp4 is ${w}px wide (< ${MIN_W} floor)`;
        if (d.recapture_pending) warns.push(`${msg} [recapture_pending: ${d.recapture_reason || 'regenerate'}]`);
        else errors.push(msg);
      }
    }
    if (d.attachment_url && !readme.includes(d.attachment_url)) {
      errors.push(`${d.id}: attachment_url not referenced in README.md`);
    }
  }
}

// Orphan recipes (a file with no manifest entry).
for (const f of readdirSync(join(DEMOS_DIR, 'workflows')).filter((f) => f.endsWith('.mjs'))) {
  const id = f.replace(/\.mjs$/, '');
  if (!demos.some((d) => d.id === id && d.kind === 'ui')) {
    errors.push(`orphan recipe workflows/${f} — add a manifest entry (or remove the file)`);
  }
}
for (const f of readdirSync(join(DEMOS_DIR, 'terminal')).filter((f) => f.endsWith('.sh'))) {
  const id = f.replace(/\.sh$/, '');
  if (!demos.some((d) => d.id === id && d.kind === 'terminal')) {
    errors.push(`orphan recipe terminal/${f} — add a manifest entry (or remove the file)`);
  }
}

for (const w of warns) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(`\ndemos check: ${demos.length} demo(s), ${warns.length} warning(s), ${errors.length} error(s)`);
process.exit(errors.length ? 1 : 0);
