# mobile-cc

[![CI](https://github.com/eyalev/mobile-cc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/eyalev/mobile-cc/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/eyalev/mobile-cc?sort=semver)](https://github.com/eyalev/mobile-cc/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> ⚠️ **Early-stage software.** mobile-cc has no built-in authentication.
> Since v0.2.0 the binary is loopback-only and won't bind a public address.
> Reach it from another device via Tailscale, `ssh -L`, or `cloudflared`
> — see [Reaching mobile-cc from elsewhere](#reaching-mobile-cc-from-elsewhere)
> and [SECURITY.md](./SECURITY.md).

**Drive Claude Code from your phone.** Open a URL in any mobile browser — no
SSH client, no copy-paste fights, no app to install on the phone.

## What you get

- **Chat-style transcript view** — renders the Claude Code conversation
  directly from the JSONL on disk (not screen-scraped from the TUI), so it
  stays clean and scrollable.
- **Quick keys row** above the soft keyboard — `Esc`, `Tab`, `Ctrl-C`, arrows.
- **Pinned tabs** — switch between tmux panes / sessions with one tap. State
  survives tmux restarts (pinned by session name).
- **Image paste / drag / pick** — attach a screenshot from your phone gallery
  or paste it from the clipboard; it gets staged on the server and inserted
  into your message as `[image: /path/...]`. Claude Code reads it the same
  way you'd paste a screenshot on desktop.
- **Pane picker** with a Recent section, per-browser memory.
- **Terminal Green theme** — CRT aesthetic, paired with the chat view.
- **Installable as an app (PWA)** — the daemon serves a web manifest +
  service worker, so Chrome on Android offers "Add to Home screen" and
  mobile-cc opens standalone (no URL bar). Requires HTTPS or localhost —
  the Tailscale path below qualifies.

A single statically-linked Rust binary, ~8 MB. No node, no python, no
runtime to install.

## Install (Linux, x86_64 or arm64)

> **Prerequisite:** `tmux` must be installed on the same host — mobile-cc
> attaches to your existing tmux server; it doesn't start one or bundle one.
> `sudo apt install tmux` on Debian/Ubuntu, `brew install tmux` on macOS.

```bash
curl -fsSL https://mobile-cc.dev/install.sh | bash
```

That:

1. Downloads the `mobile-cc` binary for your platform from
   [GitHub releases](https://github.com/eyalev/mobile-cc/releases) to
   `~/.local/bin/mobile-cc`.
2. Drops a systemd user unit at
   `~/.config/systemd/user/mobile-cc.service`, enables it, and starts it.
3. Prints the URL.

Default bind is `127.0.0.1:7800` (loopback-only — see
[Reaching mobile-cc from elsewhere](#reaching-mobile-cc-from-elsewhere)
below).

### Custom version / install dir

```bash
MOBILE_CC_VERSION=v0.2.0 curl -fsSL https://mobile-cc.dev/install.sh | bash
```

Other knobs: `MOBILE_CC_PREFIX` (binary location), `MOBILE_CC_SKIP_UNIT=1`
(don't write a systemd unit), `MOBILE_CC_BIN_FILE=/path/to/binary` (skip
download and install a local file — useful for offline machines).

> Since v0.2.0, `MOBILE_CC_BIND` is restricted to loopback addresses. The
> binary refuses any non-loopback bind — see the section below for the
> supported ways to reach it from another device.

### Survive logout

```bash
loginctl enable-linger $USER
```

Otherwise the daemon stops when you log out of SSH.

## Use it

1. Start a tmux session and run `claude` (or `claude --resume`) inside it.
2. Open `http://<host>:7800/` on your phone.
3. Use the pane picker (top-left) to find the tmux session running Claude
   Code.
4. Type into the input at the bottom. The Quick Keys row gives you `Esc`,
   arrows, `Tab`, `Ctrl-C` — the keys phone keyboards hide.

To attach screenshots from your phone: tap the 📎 button above the input.
The image is staged on the server and inserted into your message as
`[image: /path/...]` — Claude Code reads it the same way you'd paste an
image on desktop.

## Run it manually (no systemd)

```bash
mobile-cc --bind 127.0.0.1:7800 --app-name "Mobile CC"
```

Available flags:

| Flag | Default | What |
|---|---|---|
| `--bind` | `127.0.0.1:7800` | Address to bind on. Loopback only — the binary refuses anything else. |
| `--app-name` | `"Mobile CC"` | Shown in the header. Useful with multiple instances. |
| `--tmux-socket` | (default tmux) | Tmux socket name (`tmux -L`). |
| `--config-dir` | `$XDG_CONFIG_HOME/mobile-cc` | Where the plugin manifest lives. |

That's the whole CLI surface — by design. mobile-cc is a curated package,
not a kitchen-sink terminal viewer.

## Reaching mobile-cc from elsewhere

mobile-cc binds `127.0.0.1` only and has no built-in authentication.
Anyone who can reach the port can drive your shell, so the safe ways to
expose it all involve a fronting layer that provides auth. Four
supported patterns:

| Pattern | Auth | Best for |
| --- | --- | --- |
| **`ssh -L 7800:127.0.0.1:7800 <host>`** | SSH key | Reaching it from your laptop or any device with SSH access. Zero extra infra. |
| **[Tailscale](https://tailscale.com/) — `tailscale serve --bg --https=443 http://127.0.0.1:7800`** | Tailnet ACL + TLS | Phone access over your tailnet. Tailscale handles TLS via Let's Encrypt; reachable at `https://<host>.<tailnet>.ts.net/`. |
| **[Cloudflare named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) + [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/)** | Cloudflare SSO (email / SAML / OTP) | Public URL with browser-based auth. Free tier covers personal use. |
| **Reverse proxy (Caddy / nginx) + auth** | Whatever you bring (basic-auth, [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/), etc.) | Existing infra with an auth layer you already trust. |

What's **not** supported: binding the daemon to `0.0.0.0` or a LAN /
public IP directly. mobile-cc refuses to start that way since v0.2.0
because every realistic deployment of that shape — including "trusted
LAN only" — has a long history of accidental exposure (port-forward
misconfig, VPN split-tunnel, an open guest WiFi). The four patterns
above are the same effort once and remove that failure class.

For the security policy and what counts as in-scope, see
[SECURITY.md](./SECURITY.md).

## Uninstall

```bash
systemctl --user disable --now mobile-cc
rm -rf ~/.config/mobile-cc ~/.config/systemd/user/mobile-cc.service
rm -f  ~/.local/bin/mobile-cc
```

## Build from source

```bash
git clone https://github.com/eyalev/mobile-cc
cd mobile-cc
cargo build --release
./target/release/mobile-cc --help
```

Requires a checkout of [`ttyview`](https://github.com/ttyview/ttyview)
at `../ttyview` (sibling directory) — mobile-cc consumes `ttyview-core` as
a path dependency for now. Once `ttyview-core` is published to crates.io
this requirement drops.

## What this is, technically

mobile-cc is a thin Rust binary that links `ttyview-core` as a library and
bakes in:

- A fixed plugin set (8 bundled plugins, all enabled, no install step).
- A minimal CLI surface (~4 flags).
- The mobile-CC defaults: `ttyview-cc` chat view + `Terminal Green` theme.

It is *not* a fork of ttyview — every plugin, every protocol, every UI
component is upstream. mobile-cc owns its packaging shape and release
cadence, nothing else.

## License

MIT.
