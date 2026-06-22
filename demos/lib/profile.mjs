#!/usr/bin/env node
// Demo profile loader + capture-setup helper.
//
// A profile (demos/profiles/<name>.json) describes the projects / tmux sessions
// / mock content a UI demo is captured against — e.g. the multi-project tab
// rail in the README hero. See demos/CONVENTIONS.md "Profiles". This is data +
// glue only; local-capture.sh drives the actual tmux/daemon lifecycle.
//
// CLI:
//   node profile.mjs plan <name>
//     → TSV plan for the orchestrator, one line per session in pin order:
//         S\t<session>\t<cwd-subdir>\t<mock-file>
//       then the active session:
//         A\t<session>
//   node profile.mjs pins <name> <baseUrl>
//     → resolves each session to its live pane id via <baseUrl>/panes, PUTs the
//       project-ordered pins to the daemon state, and prints the ACTIVE pane id.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // demos/lib
const DEMOS = resolve(here, '..');
const PINS_KEY = 'ttv-plugin:ttyview-tabs:pins';

function load(name) {
  return JSON.parse(readFileSync(resolve(DEMOS, 'profiles', `${name}.json`), 'utf8'));
}

// Flatten projects → sessions in pin order, resolving cwd + mock per session.
function sessions(p) {
  const out = [];
  for (const proj of p.projects) {
    for (const s of proj.sessions) {
      out.push({
        session: s,
        cwd: proj.cwd || proj.name,
        mock: (p.mock && p.mock[s]) || p.default_mock || 'cc-tui-mock.txt',
      });
    }
  }
  return out;
}

const [, , cmd, name, arg] = process.argv;

if (cmd === 'plan') {
  const p = load(name);
  for (const s of sessions(p)) console.log(['S', s.session, s.cwd, s.mock].join('\t'));
  console.log(['A', p.active || sessions(p)[0].session].join('\t'));
} else if (cmd === 'pins') {
  const p = load(name);
  const base = (arg || '').replace(/\/$/, '');
  const panes = await (await fetch(`${base}/panes`)).json();
  const idOf = {};
  for (const pane of panes) idOf[pane.session] = pane.id;
  const pins = sessions(p)
    .map((s) => ({ id: idOf[s.session], session: s.session }))
    .filter((x) => x.id);
  const r = await fetch(`${base}/api/state/${encodeURIComponent(PINS_KEY)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pins),
  });
  if (!r.ok) throw new Error(`PUT pins failed: HTTP ${r.status}`);
  const active = p.active || sessions(p)[0].session;
  process.stdout.write(idOf[active] || '');
} else {
  console.error('usage: profile.mjs plan <name> | pins <name> <baseUrl>');
  process.exit(2);
}
