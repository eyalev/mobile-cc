#!/usr/bin/env node
// gen-topics — generate a Claude Code session's topics the SAME way the
// mobile-cc-tab-topics plugin does, from the command line, so the per-turn
// prompt can be iterated and compared against a hand-written "ideal".
//
// It hits a running mobile-cc daemon for the segmented turns
// (/api/cc-session-turns) and the throughline input (/api/cc-tab-summary),
// then calls Groq directly — exactly the plugin's two prompts. Override the
// per-turn prompt with --prompt-file to A/B a candidate before baking it into
// assets/mobile-cc-tab-topics.js.
//
// Usage:
//   GROQ_API_KEY=gsk_... node scripts/gen-topics.mjs --session mcc2
//   node scripts/gen-topics.mjs --session mcc2 --prompt-file /tmp/cand.txt
//   node scripts/gen-topics.mjs --session mcc2 --write     # persist to daemon (re-summarize)
//
// Flags:
//   --session <name>     tmux session (required)
//   --base <url>         daemon base (default http://127.0.0.1:7800)
//   --limit <n>          turns to fetch (default 12)
//   --prompt-file <p>    file with a candidate PER-TURN system prompt (else the default below)
//   --throughline        also print the session throughline (the tab subtitle)
//   --write              PUT generated summaries for CLOSED turns back to the daemon
//   --key-file <p>       file containing GROQ_API_KEY=... (else env GROQ_API_KEY)
//
// The DEFAULT per-turn prompt here is the source of truth I keep in sync with
// mobile-cc-tab-topics.js `genTurn`.

import fs from 'node:fs';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
// Default matches the plugin (70b versatile). Override with --model
// (e.g. llama-3.1-8b-instant) when the 70b org quota is exhausted.
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// ---- the per-turn prompt (keep in sync with the plugin's genTurn) ----
const DEFAULT_TURN_PROMPT =
  'You name what ONE turn of a Claude Code session accomplished, so a developer can scan ' +
  'the session timeline. Read the USER REQUEST (first) and the substantive code changes, then reply ' +
  'with a 3-7 word lowercase gerund phrase naming the OUTCOME — the feature added or the problem fixed, ' +
  'framed from the user\'s intent (e.g. "building tab topics feature", "hiding dormant label preview", ' +
  '"switching subtitle to throughline"). Do NOT name tools, file paths, test scripts, daemons, or other ' +
  'scaffolding used along the way, and do NOT describe exploration (reading/searching files). ' +
  'No punctuation, no quotes, no preamble — ONLY the phrase.';

const THROUGHLINE_PROMPT =
  'You write a SHORT label for a developer\'s Claude Code session tab, so they can tell tabs apart.\n' +
  'Reply with a 3-5 word lowercase gerund phrase naming the session\'s OVERALL throughline — the feature or\n' +
  'problem area it keeps returning to — NOT the most recent message. IGNORE one-off detours, bug-fix\n' +
  'tangents, and process/handoff messages. No punctuation, no quotes, no preamble — ONLY the phrase.';

// ---- args ----
const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const v = args[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
const session = flag('session');
const base = flag('base', 'http://127.0.0.1:7800');
const limit = parseInt(flag('limit', '12'), 10);
const write = !!flag('write', false);
const wantThroughline = !!flag('throughline', false);
const promptFile = flag('prompt-file');
const keyFile = flag('key-file');
const GROQ_MODEL = flag('model', DEFAULT_MODEL);
const maxDigest = parseInt(flag('max-digest', '3500'), 10);   // trim input to ease TPM limits

if (!session) { console.error('error: --session <name> required'); process.exit(2); }

function readKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  if (keyFile && fs.existsSync(keyFile)) {
    const m = fs.readFileSync(keyFile, 'utf8').match(/GROQ_API_KEY\s*=\s*(\S+)/);
    if (m) return m[1].trim();
  }
  return '';
}
const KEY = readKey();
if (!KEY) { console.error('error: no Groq key — set GROQ_API_KEY or pass --key-file <env>'); process.exit(2); }

const turnPrompt = promptFile && fs.existsSync(promptFile)
  ? fs.readFileSync(promptFile, 'utf8').trim()
  : DEFAULT_TURN_PROMPT;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function groq(sys, user, maxTokens) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(GROQ_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: GROQ_MODEL, temperature: 0.2, max_tokens: maxTokens,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user || '(empty)' }],
      }),
    });
    if (r.status === 429) {
      const body = await r.text();
      const m = body.match(/try again in ([\d.]+)s/i);
      const wait = m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : (2000 * (attempt + 1));
      process.stderr.write(`  (429 — waiting ${Math.round(wait / 1000)}s…)\n`);
      await sleep(Math.min(wait, 30000));
      continue;
    }
    if (!r.ok) throw new Error('Groq HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
    const j = await r.json();
    return ((((j.choices || [])[0] || {}).message || {}).content || '')
      .trim().replace(/^["'`]+|["'`.]+$/g, '').replace(/\s+/g, ' ');
  }
  throw new Error('Groq 429 after retries');
}

function trunc(s, n) { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

(async () => {
  const d = await (await fetch(`${base}/api/cc-session-turns?session=${encodeURIComponent(session)}&limit=${limit}`)).json();
  if (!d || !d.found) { console.error('no transcript for session', session); process.exit(1); }
  const turns = d.turns || [];
  console.log(`session "${session}" — ${turns.length} turns (total ${d.total})`);
  console.log(`prompt: ${promptFile ? promptFile : '(default per-turn prompt)'}\n`);

  if (wantThroughline) {
    try {
      const s = await (await fetch(`${base}/api/cc-tab-summary?session=${encodeURIComponent(session)}&n=6`)).json();
      const ps = s.prompts || [];
      const goal = (s.first && s.first !== ps[0]) ? `SESSION GOAL (first request):\n- ${s.first}\n\n` : '';
      const ctx = goal + 'RECENT REQUESTS (newest last):\n' + ps.map(x => '- ' + x).join('\n');
      const tl = (await groq(THROUGHLINE_PROMPT, `Session "${session}".\n\n${ctx}`, 20)).toLowerCase();
      console.log(`THROUGHLINE (tab subtitle): ${tl.split(' ').slice(0, 5).join(' ')}\n`);
    } catch (e) { console.log('throughline failed:', e.message, '\n'); }
  }

  const writes = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    let topic = '';
    const input = (t.digest || t.user_text || '').slice(0, maxDigest);
    try { topic = (await groq(turnPrompt, input, 24)).toLowerCase().slice(0, 90); }
    catch (e) { topic = '(gen failed: ' + e.message + ')'; }
    const tag = t.open ? ' ●open' : '';
    console.log(`#${String(i + 1).padStart(2)} [${(t.kind || '?').padEnd(7)}]${tag}`);
    console.log(`    req:   ${trunc(t.user_text, 70)}`);
    console.log(`    topic: ${topic}`);
    if (write && !t.open && topic && !topic.startsWith('(gen failed')) writes.push({ uuid: t.uuid, summary: topic });
  }

  if (write && writes.length) {
    const r = await fetch(`${base}/api/cc-session-turns`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, summaries: writes }),
    });
    console.log(`\nwrote ${writes.length} summaries to daemon → HTTP ${r.status}`);
  }
})().catch(e => { console.error('fatal:', e.message); process.exit(1); });
