# Mobile CC — release-demos pipeline

> **Read [`CONVENTIONS.md`](CONVENTIONS.md) first.** It is the canonical
> "demos-as-tests" convention — the one rule (no hand-made media), the
> manifest registry, the resolution standard, and the agent checklist.
> This file is the implementation reference for the contract types.

Per-release workflow captures. Doubles as a visual regression test:
each workflow's `run()` choreography must complete + its `validate()`
must pass, otherwise the release blocks. The same script that gates
the release also produces the marketing media that lands at
[mobile-cc.dev/demos/](https://mobile-cc.dev/).

Run everything (or one demo) through the single entrypoint:

```sh
demos/run.sh            # the whole suite
demos/run.sh use-flow   # one demo
demos/run.sh --list     # what's registered
node demos/check.mjs    # consistency + resolution gate (also runs in CI)
```

## Layout

```
demos/
├── workflows/
│   └── paste-flow.mjs       # one file per workflow
├── lib/
│   ├── capture.mjs          # Playwright recordVideo + ffmpeg + GIF helpers
│   └── workflow.mjs         # Workflow contract types (jsdoc)
├── runner/
│   └── run-all.mjs          # iterate workflows/, produce dist/
├── site/
│   ├── index.html           # template — demos landing page
│   └── workflow.html        # template — per-workflow page
└── dist/                    # generated, gitignored
    ├── demos/
    │   ├── paste-flow/
    │   │   ├── hero.mp4
    │   │   ├── hero.gif
    │   │   ├── hero-still.png
    │   │   └── steps.json
    │   └── index.html
    └── …
```

## Workflow contract

Each file under `workflows/` default-exports an object:

```js
export default {
  id: 'paste-flow',
  title: 'Image paste end-to-end',
  description: 'Paste a screenshot → uploads → CC ingests the [image:…]',

  /** Async; ctx provides { page, recordStep(label) }. */
  run: async (ctx) => {
    await ctx.idle(1500);                    // hold for the eye
    await ctx.recordStep('idle');
    await ctx.dispatchPaste('/tmp/foo.png'); // ctx helpers from lib/capture.mjs
    await ctx.recordStep('paste dispatched');
    // …
  },

  /** Async; returns true (pass) or throws (fail). Runs after capture. */
  validate: async (ctx) => {
    const text = await ctx.page.locator('#input-text').inputValue();
    if (text !== '') throw new Error('textarea should clear on Send');
  },
};
```

## Run locally

Pre-flight: a Mobile CC daemon on `https://127.0.0.1:7800/` with
the right plugin set. The default daemon URL is overridable via
`MOBILE_CC_URL`. The default capture pane id is `%6` (the dedicated
sanitized `ttyview-cc-demo` tmux session); override via `TTV_PANE`.

```sh
cd mobile-cc/demos
npm run capture                # iterates workflows/, writes dist/
```

Failure modes:

- A workflow's `run()` throws → that workflow's `dist/demos/<id>/`
  is left partially populated; `steps.json.error` carries the message.
- A workflow's `validate()` throws → captured assets are kept but
  `steps.json.validation = 'failed'`. The runner exits non-zero.

## Deploy (Cloudflare Pages — future)

`wrangler pages deploy demos/dist` from a CI job, gated on release
tag push. Not wired yet — Phase 1 builds output locally, deploy comes
in Phase 1.5 when there's at least one working workflow.

## Why this lives in mobile-cc and not in `ttyview-mobile-cc-demos`

Workflow captures are tests for the Mobile CC product. They belong
with the product they exercise. The (now-archived)
`eyalev/ttyview-mobile-cc-demos` repo holds the historical
experiments that led here.
