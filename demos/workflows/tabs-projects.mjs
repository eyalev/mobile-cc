// tabs-projects — the comprehensive "tabs + projects" workflow: your projects
// are tab groups; open new tabs (blank / Claude / Claude-in-a-project), create
// a new project, and MOVE a tab between projects — the last one live-regroups
// with no page reload (the fixed UX this clip is built to show).
//
// Capture leak-safe + isolated, against the FIXED plugins overlaid by
// local-capture.sh (demos/_overrides/) so the move is smooth:
//   demos/local-capture.sh tabs-projects
// Profile: multi-project (api ×3 + docs). Standard resolution (lib/capture.mjs).
//
// HONESTY (demos/CONVENTIONS.md "Determinism"): seeded CC-TUI mock content; new
// tabs are real sessions but deterministic shells (no live `claude` launch in
// frame); the "create a project" folder is a pre-made demo dir (the prod
// capture binary still needs the cwd to exist — the mkdir-on-create fix is
// server-side, shipped separately). Every gesture is a real UI action, asserted.

const NEW_PROJECT_DIR = '/tmp/mcc-democap-ws/payments'; // pre-created by local-capture.sh
const MOVE_SRC = 'api-claude2';   // the tab we move…
const MOVE_DST = 'docs';          // …into this project group

/** @type {import('../lib/workflow.mjs').Workflow} */
export default {
  id: 'tabs-projects',
  title: 'Tabs & projects — open, create, move',
  description:
    "Your projects are tab groups. Open new tabs (blank, Claude, or Claude in a " +
    "project), create a new project, and MOVE a tab from one project to another " +
    "— the move regroups live, no reload. Everything you need to juggle several " +
    "projects from the phone.",

  run: async (ctx) => {
    const { page } = ctx;
    // Sentinel: if a full-page reload sneaks in (the OLD move-to-project did
    // location.reload()), this is wiped. validate() checks it survived → proves
    // the move regrouped LIVE.
    await page.evaluate(() => { window.__tabsDemoSentinel = 'alive'; });

    // 1) OPEN — the multi-project tab rail (api ×3 + docs), one CC session live.
    await ctx.idle(2200);
    await ctx.recordStep('projects as tab groups');

    // 2) SWITCH PROJECT — one tap to the docs project.
    await ctx.tap(() =>[...document.querySelectorAll('.pp-item')].find(e => /docs-claude1/.test(e.textContent || '')));
    await ctx.idle(1600);
    await ctx.recordStep('switched to the docs project');

    // 3) NEW-TAB MENU — the ＋ on the rail opens three ways to start a session.
    await ctx.tap(() =>document.getElementById('mcc-newtab-railbtn'));
    await ctx.idle(1200);
    await ctx.recordStep('new-tab menu (blank · Claude · Claude in project)');
    await ctx.stillSnapshot('newtab-menu');

    // 4) NEW TAB — make a blank one (deterministic); a new tab appears.
    await ctx.tap(() =>[...document.querySelectorAll('#mcc-newtab-menu button')].find(b => /Blank tab/.test(b.textContent || '')));
    await ctx.idle(1800);
    await ctx.recordStep('blank tab created');

    // 5) CREATE A PROJECT — ＋ → "Claude in project…" → point at a folder →
    //    Create. A new project group appears on the rail.
    await ctx.tap(() =>document.getElementById('mcc-newtab-railbtn'));
    await ctx.idle(700);
    await ctx.tap(() =>[...document.querySelectorAll('#mcc-newtab-menu button')].find(b => /Claude in project/.test(b.textContent || '')));
    await ctx.idle(900);
    await page.evaluate((dir) => {
      const inp = [...document.querySelectorAll('input[type=text]')].find(i => /project folder|absolute path|\/home\/you/i.test(i.placeholder || ''));
      if (!inp) throw new Error('project folder input not found');
      inp.focus(); inp.value = dir;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, NEW_PROJECT_DIR);
    await ctx.recordStep('Claude in a new project folder');
    await ctx.idle(900);
    await ctx.tap(() => { const m = [...document.querySelectorAll('div')].find(d => { const h = d.querySelector(':scope > h3'); return h && /Claude in project/.test(h.textContent || ''); }); return m ? [...m.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Create') : null; });
    await ctx.idle(1600);
    // Switch back to a seeded CC session so the active pane stays clean (the new
    // project's pane is launching in the background); the rail shows the group.
    await page.evaluate(() => { const p = window.ttyview.listPanes().find(x => x.session === 'api-claude1'); if (p) window.ttyview.selectPane(p.id); });
    await ctx.idle(4500); // let the new session surface (daemon reconcile) so its auto-pin lands
    await ctx.recordStep('new "payments" project on the rail');

    // 6) SURVEY — several projects at once (poster frame). Bring the new,
    // auto-pinned "payments" project group into view so it's visible.
    await page.evaluate(() => {
      const g = [...document.querySelectorAll('.ttvtab-ghead')].find(h => /payments/.test(h.textContent || ''));
      if (!g) return;
      let el = g.parentElement;
      while (el) { const s = getComputedStyle(el); if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) { el.scrollTop = el.scrollHeight; break; } el = el.parentElement; }
    });
    await ctx.idle(800);
    await ctx.stillSnapshot('hero-still');
    await ctx.idle(1200);
    await ctx.recordStep('juggling several projects');

    // 7) MOVE A TAB BETWEEN PROJECTS — ⋮ on an api tab → Move to project → docs.
    //    Regroups LIVE (no reload — the headline fix).
    await ctx.tap(() =>document.querySelector('button.mcc-tabmenu-btn[data-session="' + 'api-claude2' + '"]'));
    await ctx.idle(900);
    await ctx.tap(() =>[...document.querySelectorAll('#mcc-tabmenu button')].find(b => /Move to project/.test(b.textContent || '')));
    await ctx.idle(1100);
    await ctx.recordStep('Move to project → pick a project');
    await ctx.tap(() => { const m = [...document.querySelectorAll('div')].find(d => { const h = d.querySelector(':scope > h3'); return h && /^Move "/.test(h.textContent || ''); }); return m ? [...m.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'docs') : null; });
    // The rename fast-path (reconcile_now) reflects the new session name in
    // /panes within one reconcile, so the tab regroups under docs almost
    // immediately — and with NO page reload (the headline fix). A short settle +
    // refresh covers the reconcile round-trip.
    await ctx.idle(2600);
    await page.evaluate(async () => { try { await window.ttyview.refreshPanes(); } catch (e) {} if (typeof window.ttvTabsReloadPins === 'function') window.ttvTabsReloadPins(); });
    await ctx.idle(1600);
    await ctx.recordStep('tab moved to docs — live, no reload');

    // 8) SETTLE.
    await ctx.idle(1400);
    await ctx.recordStep('settled');
  },

  validate: async (ctx) => {
    const { page } = ctx;
    const state = await page.evaluate(() => ({
      sentinel: window.__tabsDemoSentinel || null,
      sessions: window.ttyview.listPanes().map(p => p.session),
      chars: (document.getElementById('grid-host')?.textContent || '').replace(/\s+/g, '').length,
    }));
    if (state.chars < 20) throw new Error(`expected a rendered terminal grid; got ${state.chars} chars`);
    // The move regrouped LIVE — no full-page reload wiped our sentinel.
    if (state.sentinel !== 'alive') throw new Error('page reloaded during the demo — move-to-project should regroup live');
    // New blank tab created.
    if (!state.sessions.includes('tab')) throw new Error(`expected a 'tab' session; got ${JSON.stringify(state.sessions)}`);
    // New project created ("Claude in project" → payments-claude1).
    if (!state.sessions.some(s => /^payments-claude/.test(s))) {
      throw new Error(`expected a payments-claude* session; got ${JSON.stringify(state.sessions)}`);
    }
    // Tab moved: api-claude2 was renamed into the docs group; the source name
    // is gone and an extra docs-claude* now exists.
    if (state.sessions.includes('api-claude2')) throw new Error('api-claude2 should have been renamed into docs; sessions=' + JSON.stringify(state.sessions));
    const docs = state.sessions.filter(s => /^docs-claude/.test(s));
    if (docs.length < 2) throw new Error(`expected api-claude2 moved into docs (>=2 docs-claude*); got ${JSON.stringify(state.sessions)}`);
  },
};
