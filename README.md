# mobile-cc

**Drive Claude Code from your phone.** Open a URL in any mobile browser — no
SSH client, no copy-paste fights, no app to install on the phone.

<!-- demo gif goes here -->

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

A single statically-linked Rust binary, ~8 MB. No node, no python, no
runtime to install.

## Install (Linux, x86_64 or arm64)

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

Default bind is `127.0.0.1:7800`. Reach it from your phone via Tailscale,
`ssh -L`, or `cloudflared tunnel`.

### Custom bind / version / install dir

```bash
MOBILE_CC_BIND=0.0.0.0:7800 MOBILE_CC_VERSION=v0.1.0 \
  curl -fsSL https://mobile-cc.dev/install.sh | bash
```

Other knobs: `MOBILE_CC_PREFIX` (binary location), `MOBILE_CC_SKIP_UNIT=1`
(don't write a systemd unit), `MOBILE_CC_BIN_FILE=/path/to/binary` (skip
download and install a local file — useful for offline machines).

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
| `--bind` | `127.0.0.1:7800` | Address to bind on. |
| `--app-name` | `"Mobile CC"` | Shown in the header. Useful with multiple instances. |
| `--tmux-socket` | (default tmux) | Tmux socket name (`tmux -L`). |
| `--config-dir` | `$XDG_CONFIG_HOME/mobile-cc` | Where the plugin manifest lives. |

That's the whole CLI surface — by design. mobile-cc is a curated package,
not a kitchen-sink terminal viewer.

## Security

The daemon writes keystrokes to your tmux. **Anyone who can reach the port
can drive your shell.** Two sane setups:

- **Default (recommended):** bind `127.0.0.1`, reach it via
  [Tailscale](https://tailscale.com/) (free for personal use). Your phone
  joins the tailnet; nobody else on the internet can touch the port.
- **VPS with public bind:** acceptable only with TLS and access controls.
  Set `MOBILE_CC_BIND=0.0.0.0:7800` at install time, terminate TLS with
  Caddy or `cloudflared`, put basic auth or `oauth2-proxy` in front.

mobile-cc has no built-in auth — that's by design ("small, trusted network
only"). If you need a public-internet-safe deployment, run it behind your
existing reverse proxy.

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
