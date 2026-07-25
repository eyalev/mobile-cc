#!/usr/bin/env node
// check-assets — a gate for the plugin JS that gets baked into the binary.
//
// Run:  node scripts/check-assets.mjs
// CI:   .github/workflows/ci.yml `assets` job
//
// Why this exists: everything under assets/ is embedded with `include_bytes!`
// and shipped inside the binary. Rust CI never parses it, there is no bundler
// and no test runner, so a syntax error or a known-bad pattern reaches users
// as a silently dead plugin — the UI just quietly loses a feature. These are
// the cheapest checks that would actually have caught something.
//
// Deliberately zero-dependency (no package.json, no node_modules): the repo
// has no JS toolchain and this is not the place to introduce one.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

/** Every .js file that gets baked in: the plugins plus the PWA service worker. */
function bakedFiles() {
  const out = [];
  for (const dir of ['assets', 'assets/pwa']) {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.js')) out.push(join(dir, name));
    }
  }
  return out.sort();
}

/**
 * 1. Parse check. `node --check` is a full parse without executing, so it
 *    catches the class of breakage that otherwise ships: a stray brace in a
 *    plugin that Rust happily embeds as bytes.
 */
function checkSyntax(files) {
  for (const rel of files) {
    try {
      execFileSync(process.execPath, ['--check', join(ROOT, rel)], { stdio: 'pipe' });
    } catch (e) {
      const detail = String(e.stderr || e.message).split('\n').slice(0, 3).join('\n    ');
      errors.push(`${rel}: does not parse\n    ${detail}`);
    }
  }
}

/**
 * Blank out comments, preserving every byte offset and newline so reported
 * line numbers stay exact. `//` is only treated as a comment when it is not
 * preceded by ':', so URLs like `https://…` survive intact.
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
  return out;
}

/**
 * 2. No raw PUT to /api/state.
 *
 *    Plugin state must be written through `tv.storage(...).set()`, which sends
 *    a merge/delta PATCH. A whole-object PUT is last-write-wins across every
 *    connected client, which is exactly how tab pins and group colours got
 *    wiped twice (see memory `mobile-cc-pins-persistence`). Reads (GET) are
 *    fine.
 *
 *    Heuristic, deliberately narrow to avoid crying wolf: comments are blanked
 *    first; the `method: 'PUT'` must appear AFTER the URL (where fetch options
 *    go), within a short window; and the window is cut at the next `fetch(` so
 *    a PUT belonging to an unrelated adjacent call can't be misattributed.
 */
function checkNoRawStatePut(files) {
  const WINDOW = 200;
  for (const rel of files) {
    const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    for (let i = src.indexOf('/api/state'); i !== -1; i = src.indexOf('/api/state', i + 1)) {
      let after = src.slice(i, i + WINDOW);
      const nextCall = after.indexOf('fetch(', 1);
      if (nextCall !== -1) after = after.slice(0, nextCall);
      if (/method\s*:\s*['"]PUT['"]/.test(after)) {
        const lineNo = src.slice(0, i).split('\n').length;
        errors.push(
          `${rel}:${lineNo}: raw PUT to /api/state — use tv.storage(...).set() so the ` +
            `write is a merge PATCH, not a last-write-wins overwrite of every ` +
            `other client's state.`
        );
      }
    }
  }
}

/**
 * 3. The Capacitor JS↔Java contract holds.
 *
 *    The native shell's plugin methods are reached from JS by string name, so
 *    nothing checks them: no compiler, no bundler, no test. Rename a method in
 *    LastScreenshotPlugin.java and the JS keeps calling the old name — the
 *    failure surfaces only on a physical Android device, which is exactly the
 *    device this repo has never been able to test on automatically.
 *
 *    Skipped silently if the Java file isn't present (the worktree may be a
 *    partial checkout).
 */
function checkNativePluginContract() {
  const javaPath = join(
    ROOT,
    'android-app/android/app/src/main/java/dev/mobilecc/app/LastScreenshotPlugin.java'
  );
  let java;
  try {
    java = readFileSync(javaPath, 'utf8');
  } catch {
    return;
  }

  // Methods the native side actually exposes to the bridge.
  const exposed = new Set();
  const re = /@PluginMethod[\s\S]{0,200}?public\s+void\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (let m; (m = re.exec(java)); ) exposed.add(m[1]);
  if (exposed.size === 0) {
    errors.push(`${javaPath}: no @PluginMethod found — has the plugin been renamed or moved?`);
    return;
  }

  // Resolve which identifiers actually hold the plugin before matching calls
  // on them. Matching a bare receiver name is not good enough — an early
  // version keyed on `p.` and flagged `p.split(...)` and `p.closest(...)`.
  const ACCESSOR = /\b(?:nativePlugin|plugin)\(\)/.source;
  for (const rel of ['assets/mobile-cc-native-screenshot.js', 'assets/mobile-cc-download.js']) {
    let src;
    try {
      src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    } catch {
      continue;
    }

    // `var p = plugin();` / `const x = nativePlugin();` → p, x are receivers.
    const receivers = new Set(['_plugin']);
    const bindRe = new RegExp(`\\b(?:var|let|const)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${ACCESSOR}`, 'g');
    for (let m; (m = bindRe.exec(src)); ) receivers.add(m[1]);

    const alt = [...receivers].map((r) => r.replace(/\$/g, '\\$')).join('|');
    const callRe = new RegExp(`(?:${ACCESSOR}|\\b(?:${alt}))\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    for (let m; (m = callRe.exec(src)); ) {
      const method = m[1];
      if (/^(then|catch|finally)$/.test(method)) continue;
      if (!exposed.has(method)) {
        const lineNo = src.slice(0, m.index).split('\n').length;
        errors.push(
          `${rel}:${lineNo}: calls native plugin method '${method}', which ` +
            `LastScreenshotPlugin.java does not expose (@PluginMethod: ` +
            `${[...exposed].sort().join(', ')}). This fails only on a real device.`
        );
      }
    }
  }
}

const files = bakedFiles();
if (files.length === 0) {
  console.error('assets check: found no baked .js files — is the layout still assets/*.js?');
  process.exit(1);
}
checkSyntax(files);
checkNoRawStatePut(files);
checkNativePluginContract();

for (const e of errors) console.error(`error: ${e}`);
console.log(`\nassets check: ${files.length} baked file(s), ${errors.length} error(s)`);
process.exit(errors.length === 0 ? 0 : 1);
