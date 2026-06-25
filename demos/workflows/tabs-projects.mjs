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

function tapEl(page, finder) {
  return page.evaluate((fn) => {
    const el = (new Function('return (' + fn + ')'))()();
    if (!el) throw new Error('tap target not found');
    el.scrollIntoView({ block: 'center' });
    for (const t of ['pointerdown', 'pointerup']) {
      el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true }));
    }
    el.click();
    return true;
  }, finder.toString());
}

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
    await tapEl(page, () =>[...document.querySelectorAll('.pp-item')].find(e => /docs-claude1/.test(e.textContent || '')));
    await ctx.idle(1600);
    await ctx.recordStep('switched to the docs project');

    // 3) NEW-TAB MENU — the ＋ on the rail opens three ways to start a session.
    await tapEl(page, () =>document.getElementById('mcc-newtab-railbtn'));
    await ctx.idle(1200);
    await ctx.recordStep('new-tab menu (blank · Claude · Claude in project)');
    await ctx.stillSnapshot('newtab-menu');

    // 4) NEW TAB — make a blank one (deterministic); a new tab appears.
    await tapEl(page, () =>[...document.querySelectorAll('#mcc-newtab-menu button')].find(b => /Blank tab/.test(b.textContent || '')));
    await ctx.idle(1800);
    await ctx.recordStep('blank tab created');

    // 5) CREATE A PROJECT — ＋ → "Claude in project…" → point at a folder →
    //    Create. A new project group appears on the rail.
    await tapEl(page, () =>document.getElementById('mcc-newtab-railbtn'));
    await ctx.idle(700);
    await tapEl(page, () =>[...document.querySelectorAll('#mcc-newtab-menu button')].find(b => /Claude in project/.test(b.textContent || '')));
    await ctx.idle(900);
    await page.evaluate((dir) => {
      const inp = [...document.querySelectorAll('input[type=text]')].find(i => /project folder|absolute path|\/home\/you/i.test(i.placeholder || ''));
      if (!inp) throw new Error('project folder input not found');
      inp.focus(); inp.value = dir;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, NEW_PROJECT_DIR);
    await ctx.recordStep('Claude in a new project folder');
    await ctx.idle(900);
    await tapEl(page, () => { const m = [...document.querySelectorAll('div')].find(d => { const h = d.querySelector(':scope > h3'); return h && /Claude in project/.test(h.textContent || ''); }); return m ? [...m.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Create') : null; });
    await ctx.idle(1600);
    // Switch back to a seeded CC session so the active pane stays clean (the new
    // project's pane is launching in the background); the rail shows the group.
    await page.evaluate(() => { const p = window.ttyview.listPanes().find(x => x.session === 'api-claude1'); if (p) window.ttyview.selectPane(p.id); });
    await ctx.idle(1500);
    await ctx.recordStep('new "payments" project on the rail');

    // 6) SURVEY — several projects at once (poster frame).
    await ctx.stillSnapshot('hero-still');
    await ctx.idle(1200);
    await ctx.recordStep('juggling several projects');

    // 7) MOVE A TAB BETWEEN PROJECTS — ⋮ on an api tab → Move to project → docs.
    //    Regroups LIVE (no reload — the headline fix).
    await tapEl(page, () =>document.querySelector('button.mcc-tabmenu-btn[data-session="' + 'api-claude2' + '"]'));
    await ctx.idle(900);
    await tapEl(page, () =>[...document.querySelectorAll('#mcc-tabmenu button')].find(b => /Move to project/.test(b.textContent || '')));
    await ctx.idle(1100);
    await ctx.recordStep('Move to project → pick a project');
    await tapEl(page, () => { const m = [...document.querySelectorAll('div')].find(d => { const h = d.querySelector(':scope > h3'); return h && /^Move "/.test(h.textContent || ''); }); return m ? [...m.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'docs') : null; });
    await ctx.recordStep('moving…');
    // The daemon reflects a tmux session rename on its ~5s reconcile, so give it
    // a beat, then refresh panes + re-pin: the tab settles under the docs
    // project — still NO page reload (the headline fix).
    await ctx.idle(6500);
    await page.evaluate(async () => { try { await window.ttyview.refreshPanes(); } catch (e) {} if (typeof window.ttvTabsReloadPins === 'function') window.ttvTabsReloadPins(); });
    await ctx.idle(1800);
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
