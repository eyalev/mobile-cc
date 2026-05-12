# mobile-cc/demos — GCP capture host

Captures run on a **dedicated GCP VM**, not your dev machine.
Rationale: artifacts must never carry private data (real CC sessions,
real Anthropic tokens, real `/home/<you>/…` paths, real session names
visible in the pane picker, etc.).

The architecture in one line:

```
clean Debian VM → bootstrap.sh → mobile-cc + fake JSONL fixture →
  npm run capture → dist/ → wrangler pages deploy → mobile-cc.dev/demos
```

## Components

| Path | Role |
| --- | --- |
| `bootstrap.sh` | Idempotent provisioning script. Apt installs deps, downloads pinned mobile-cc release tarball, sets up fixture pane + JSONL, installs Playwright. Run **on** the VM. |
| `provision-vm.sh` | `gcloud` orchestration: create/start the VM, scp bootstrap, run it, run the capture, scp `dist/` back to your dev machine OR straight to Cloudflare Pages. Run **from** your dev machine. |
| `../fixtures/cc-transcript.jsonl` | Sanitised fake CC conversation (debounce + Jest tests). Picked up by `ttyview-cc` plugin via cwd encoding. |
| `../fixtures/cc-tui-mock.txt` | Text that mimics CC's TUI in the cell-grid view (model bar, prompt, code blocks). `cat`'d into the demo pane so the cell-grid renders something CC-shaped without a real Anthropic token. |
| `../fixtures/paste-screenshot.png` | Synthetic 320×240 "Bug screenshot" PNG. Used by paste-flow workflow. No real content. |

## VM specs (Phase 1)

- Project: **dedicated** (suggest `mobile-cc-capture` — new — to keep blast radius off the `ttyview-demo` project that hosts Tier-1 Cloud Run).
- Type: `e2-medium` (2 vCPU, 4 GB RAM — Chrome + ffmpeg need a little headroom).
- Image: `debian-12`.
- Disk: 30 GB SSD (Chromium download ~200 MB, ffmpeg + Node ~150 MB, plenty of headroom).
- Region: `us-central1-a` (free-tier eligible).
- User: `demo` (uid 1000). **No `eyalev` anywhere in paths.**
- Hostname: `mobile-cc-capture` (whatever — but NOT `eyalev-thinkpad`).
- Public IP: yes (for `gcloud ssh`); firewall lets only `22/tcp` from your IP. No HTTP/HTTPS needed — the daemon is `127.0.0.1`-bound on the VM.
- No Tailscale, no real CC, no real Anthropic token.

Cost: ~$0.04/hour running, ~$0/month stopped (preserved disk only).
A capture run takes 2–3 minutes; stop the VM when done.

## Flow

### One-time setup

1. `gcloud projects create mobile-cc-capture --set-as-default`
2. `gcloud services enable compute.googleapis.com`
3. From your dev machine: `./provision-vm.sh create` — creates the VM, runs bootstrap.

### Each capture

```sh
./provision-vm.sh start    # boot it if stopped (~30 s)
./provision-vm.sh capture  # ssh in, run `npm run capture`, scp dist/ back
./provision-vm.sh stop     # stop the VM (preserves state, ~$0/mo idle)
```

`./provision-vm.sh capture` pulls `dist/` back to
`mobile-cc/demos/dist/` on your dev machine. From there:

```sh
wrangler pages deploy mobile-cc/demos/dist --project-name mobile-cc-demos
```

…goes live at `mobile-cc.dev/demos/`.

### When you want to fully wipe and start over

```sh
./provision-vm.sh delete   # destroy the instance (disk too)
./provision-vm.sh create   # re-provision from scratch
```

State on the VM that gets reset on `delete`: the demo tmux session,
any local plugin state, Chromium cache, capture outputs. Bootstrap is
idempotent so `create` always gives a byte-identical environment.

## Why fake JSONL + mock TUI text, not real CC

Three reasons:

1. **No Anthropic token on the VM.** Token in a GH Actions secret is
   manageable, but eliminating it is one less attack surface.
2. **Byte-identical captures.** Real CC's response varies across runs
   (temperature, model updates). Our captures double as visual
   regression tests — that needs determinism.
3. **No API cost per release.** A capture is just Playwright + ffmpeg;
   no token spend.

Trade-off: the "CC actually thinking" trust signal is weaker. If you
want a "look, real Claude really responded" workflow later, add a
**second** workflow that uses a real (scoped) token, run from the same
VM but its own session. Keeps the hero workflow deterministic and the
"authenticity" workflow purpose-built.

## Status

**Phase B v1**: bootstrap script + fixtures + workflow update — committed.
**Phase B v2**: `provision-vm.sh` (gcloud orchestration) — pending.
**Phase B v3**: Cloudflare Pages deploy automation — pending.
**Phase C**: per-release archives + cross-version diff — Phase 2/3 from
the original plan; build only when ≥2 workflows are stable.
