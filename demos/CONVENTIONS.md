# Demos-as-tests — project convention

**Read this before adding, changing, or regenerating any video / GIF / demo
screenshot in this repo.** It applies to every agent and every contributor.

## The one rule

> **Every `.mp4` / `.gif` / demo `.png` in the repo is a _derived artifact_
> produced by a checked-in, re-runnable recipe. A hand-made or one-off screen
> recording is a bug.**

The blurry 300px `use.mp4` happened because a recording was made ad-hoc,
outside any recipe, at the wrong resolution. This convention exists so that
never happens again and so we can scale to many videos across many features.

## Why "as tests"

A demo is not just marketing media — it's a **reproducible workflow that
asserts**. Each demo's `run()` choreographs the workflow; its `validate()`
throws if the product no longer behaves. Re-running a demo therefore does two
things at once:

1. **Regenerates** the media at the current state of the product.
2. **Tests** that the workflow still works (a failed `validate()` fails the run).

If a feature breaks, its demo fails to capture — that's the signal.

## Anatomy of a demo

```
demos/
├── manifest.json        # THE REGISTRY — one entry per demo (source of truth)
├── run.sh               # single entrypoint: run.sh [all|<id>|--list]
├── check.mjs            # consistency + resolution gate (CI, no daemon needed)
├── workflows/<id>.mjs   # UI demos (Playwright): { id, title, description, run, validate }
├── terminal/<id>.sh     # terminal demos (asciinema): self-contained recorders
├── lib/
│   ├── capture.mjs      # shared Playwright→mp4/gif pipeline + the RESOLUTION standard
│   ├── manifest.mjs     # manifest loader + canonical paths
│   └── gif-to-mp4.sh    # shared gif→web-mp4 encode
└── dist/                # generated UI captures (gitignored)
docs/media/<media>.{mp4,gif,png}   # the COMMITTED assets the README references
```

Two **kinds** of demo, one convention:

| Kind | Recipe | Captures | Needs a daemon? |
| --- | --- | --- | --- |
| `ui` | `workflows/<id>.mjs` | the live app via Playwright | yes (`MOBILE_CC_URL`) |
| `terminal` | `terminal/<id>.sh` | a shell flow via asciinema | no (self-contained) |

## The manifest is the spine

Every demo has exactly one entry in `manifest.json`:

```jsonc
{
  "id": "use-flow",            // == workflows/use-flow.mjs (ui) or terminal/use-flow.sh
  "kind": "ui",                // "ui" | "terminal"
  "title": "...",
  "description": "...",
  "media": "use",              // -> docs/media/use.{mp4,gif,png}; null = test-only, not published
  "attachment_url": "https://github.com/user-attachments/assets/<uuid>",  // README player embed
  "recapture_pending": true,   // optional: downgrades the resolution gate to a warning
  "recapture_reason": "..."    // why, and how to fix
}
```

`check.mjs` enforces that the manifest, the recipes, the committed media, and
the README stay in sync. There are **no demos that aren't in the manifest**
(orphan recipe = CI error) and **no manifest entries without a recipe**.

## Resolution standard (why videos must be sharp)

GitHub stretches an embedded video to fill the content column; on a 3×-DPR
phone that's ~1200 device pixels. **A source narrower than that gets upscaled
and looks blurry.** So:

- **UI demos** are captured as a **`page.screenshot` filmstrip** at device
  resolution (412×915 CSS × DPR 3 → sharp 1236-wide frames), assembled with
  ffmpeg. This is set once in `lib/capture.mjs` (`DPR`, the filmstrip loop) —
  never tune per-workflow; go sharper by raising `DPR`, not the CSS viewport.
  **Do NOT use Playwright `recordVideo` or CDP `Page.startScreencast`** — both
  capture at CSS-viewport resolution and ignore `deviceScaleFactor` (recordVideo
  also *pads* a larger `size` into a corner → the gray-void bug). `page.screenshot`
  is the only DPR-honouring capture path.
- **Terminal demos** record with a large `--font-size` so text stays crisp
  after GitHub's downscale.
- `check.mjs` fails the build if a committed mp4 is under `min_video_width`
  (640). Re-encoding a too-small file does **not** help — upscaling invents no
  detail. You must re-capture.

## How to run

The one-command path — stands up an **isolated synthetic daemon**, applies the
demo's profile, captures, and tears down (no live `:7800`, no real sessions):

```sh
demos/local-capture.sh use-flow   # capture one UI demo end-to-end, isolated
```

The lower-level entrypoint (assumes a daemon is already running at
`MOBILE_CC_URL`, capture pane `TTV_PANE`):

```sh
demos/run.sh                 # the whole suite (regression gate)
demos/run.sh use-flow        # one demo
demos/run.sh --list          # what exists
```

Terminal demos run the real install paths in a temp prefix and clean up after
themselves. `run.sh` publishes each passing demo's media into
`docs/media/<media>.*` and reminds you to re-upload changed mp4s (below).

## Profiles (the demo's seeded world)

A UI demo is captured against a **profile** — `demos/profiles/<name>.json` —
that describes the projects, tmux sessions, mock content, and the
project-grouped pinned tabs the capture should show. A demo opts in via its
manifest `profile` field (`local-capture.sh` reads it). This is how the README
"See it" clip shows the real **multi-project tab rail** (an `api` project with
three Claude Code sessions + a `docs` project) instead of one bare session.

Key facts the profile system relies on:

- **Tab groups** come from **pinned** sessions (daemon state key
  `ttv-plugin:ttyview-tabs:pins` = `[{id, session}, …]`). The group label is
  auto-derived from the session-name prefix — `api-claude1` → group `api`.
- **`local-capture.sh`** creates the sessions on a dedicated `tmux -L` socket,
  `cat`s each session's mock fixture (`demos/fixtures/*.txt`) into it, starts
  the isolated daemon, then PUTs the pins (via `lib/profile.mjs`) so the rail
  renders grouped. The profile's `active` session becomes `TTV_PANE`.
- **Add a scenario** = add a `demos/profiles/<name>.json` (+ any new mock
  fixtures) and point a demo's manifest `profile` at it. No code change. Use
  this for other workflow shots (e.g. a permission-prompt scenario, a
  single-session beginner view).

## Authoring UI workflows (gotchas)

- **Prefer the `window.ttyview` API for hooks** — `getActivePane()`,
  `selectPane(id)`, `openPanePicker()`, `sendInput()`, `listPanes()`. They're
  stable and make robust `validate()`s (e.g. assert
  `getActivePane().session === '…'`).
- **The tab rail + input bar live in a fixed bottom container.** Playwright's
  `locator.click()` refuses them ("element is outside of the viewport" even
  though it's visible) because it can't scroll a fixed element to center. Tap
  them by dispatching the pointer sequence on the element inside
  `page.evaluate` instead:
  ```js
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true }));
  el.click();
  ```
  (This fires the same touch handler a real tap does — see `tab-switch.mjs` /
  `pane-picker.mjs`.) This is a Playwright-actionability quirk, **not** proof
  the control is unreachable on a real touch device.
- **Useful selectors:** tabs `.pp-item[data-pane-id]` (active = `.pp-item.active`),
  new-session `#mcc-newtab-railbtn`, pane picker `#pane-picker-overlay.open`,
  command palette `#cmd-palette-overlay`, IO `#input-text` / `#send-btn` /
  `#grid-host` / `#ttv-img-preview`, the `▶ cc` command chip.

## The README embed step

GitHub strips hand-written `<video>` tags. An mp4 only renders as an inline
player via a `github.com/user-attachments/assets/<uuid>` URL, minted by
uploading the file through a GitHub web composer. After regenerating an mp4:

1. Mint a fresh user-attachments URL (automated recipe below, or drag the file
   into any GitHub issue/comment).
2. Finalize it: reference the URL from **issue #1** (`gh issue edit 1`).
   Unposted/abandoned attachments **404 anonymously** — they only become
   publicly served once referenced by posted content. Issue #1 exists solely
   to keep these public; don't delete it.
3. Update the `attachment_url` in **both** `README.md` and `manifest.json`.

The committed `docs/media/<media>.mp4` is the source-of-truth artifact; the
attachment URL is just the README's player handle. `check.mjs` verifies every
`attachment_url` is actually referenced in the README.

### Automated re-upload (agent-browser + a logged-in Chrome)

Proven recipe — works headless against the CDP debug Chrome (logged into
GitHub). **Key gotcha:** use the **`issues/new`** form's textarea (placeholder
`Type your description here…`) — its drop handler honors synthetic events. The
issue-#1 *comment* box is the newer React composer and silently ignores
synthetic drops, which is the trap that wastes an hour.

```sh
# 1. open the new-issue composer
agent-browser --cdp 9222 tab new "https://github.com/eyalev/mobile-cc/issues/new"
agent-browser --cdp 9222 wait --load networkidle

# 2. fetch the committed mp4 SAME-ORIGIN (it must already be pushed to main),
#    build a File, and dispatch a synthetic drop on the description textarea:
cat <<'EOF' | agent-browser --cdp 9222 eval --stdin
(async()=>{
  const r=await fetch('https://github.com/<owner>/<repo>/raw/main/docs/media/<media>.mp4',{cache:'no-store'});
  if(!r.ok) return 'FETCH_FAIL '+r.status;
  const file=new File([await r.blob()],'<media>.mp4',{type:'video/mp4'});
  const ta=[...document.querySelectorAll('textarea')].find(t=>/description/i.test(t.placeholder||''))||[...document.querySelectorAll('textarea')].pop();
  if(!ta) return 'NO_TEXTAREA';
  ta.value=''; ta.focus();
  const dt=new DataTransfer(); dt.items.add(file);
  for(const type of ['dragenter','dragover','drop']){const ev=new DragEvent(type,{bubbles:true,cancelable:true,composed:true});Object.defineProperty(ev,'dataTransfer',{value:dt});ta.dispatchEvent(ev);}
  return 'dropped';
})()
EOF

# 3. poll the textarea until GitHub replaces the placeholder with the URL:
#    grep its .value for https://github.com/user-attachments/assets/<uuid>
# 4. gh issue edit 1 --repo <owner>/<repo> --body "...new URL..."   (finalize)
# 5. close the new-issue tab WITHOUT submitting (the asset is already minted)
# 6. swap the URL into README.md + manifest.json, commit, push
# 7. verify anon: curl -I the URL → HTTP 200, type=video/mp4
```

## Determinism

- Synthetic / seeded data only — `demos/fixtures/`, a sanitized demo tmux
  session, `--demo`-style synthetic CC content. No real conversations, paths,
  or secrets in any frame.
- Fixed viewport + encode settings (in `lib/capture.mjs`) so re-runs are
  byte-stable modulo timing.

## Agent checklist

- **Shipping a feature?** Add or update its demo: a `workflows/<id>.mjs` (UI)
  or `terminal/<id>.sh` (terminal) recipe **and** a `manifest.json` entry.
- **Refreshing media?** `demos/run.sh <id>` → commit the `docs/media/` outputs
  → re-upload the mp4 → bump `attachment_url` in README + manifest.
- **Never** hand-edit, hand-record, or drag a one-off clip into the README.
  If you can't reproduce it from a recipe, it doesn't ship.
- **Before committing media changes**, run `node demos/check.mjs` (CI runs it
  too). Fix errors; clear a `recapture_pending` warning by actually
  re-capturing and dropping the flag.
