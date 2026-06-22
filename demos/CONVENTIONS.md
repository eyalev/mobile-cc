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

- **UI demos** record at **viewport × DPR** (currently 412×915 CSS × 3 = a
  1236-wide capture). This is set once in `lib/capture.mjs` (`DPR`,
  `RECORD_SIZE`) — never tune resolution per-workflow. Go sharper by raising
  `DPR`, not by changing the CSS viewport (that would change the mobile layout).
- **Terminal demos** record with a large `--font-size` so text stays crisp
  after GitHub's downscale.
- `check.mjs` fails the build if a committed mp4 is under `min_video_width`
  (640). Re-encoding a too-small file does **not** help — upscaling invents no
  detail. You must re-capture.

## How to run

```sh
demos/run.sh                 # the whole suite (regression gate)
demos/run.sh use-flow        # one demo
demos/run.sh --list          # what exists
```

UI demos need a mobile-cc daemon (default `https://127.0.0.1:7800/`, override
`MOBILE_CC_URL`) whose capture pane (`TTV_PANE`) runs **seeded, synthetic**
content — never real secrets. Terminal demos run the real install paths in a
temp prefix and clean up after themselves.

`run.sh` publishes each passing demo's media into `docs/media/<media>.*` and
then reminds you to re-upload changed mp4s (next section).

## The README embed step (manual, unavoidable)

GitHub strips hand-written `<video>` tags. An mp4 only renders as an inline
player via a `github.com/user-attachments/assets/<uuid>` URL, which is minted
by **uploading the file through GitHub's web composer** (drag it into an
issue/comment — issue #1 hosts ours; don't delete it). So after regenerating
an mp4:

1. Re-upload it to user-attachments.
2. Update its `attachment_url` in **both** `README.md` and `manifest.json`.

The committed `docs/media/<media>.mp4` is the source-of-truth artifact; the
attachment URL is just the README's player handle. `check.mjs` verifies every
`attachment_url` is actually referenced in the README.

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
