#!/usr/bin/env bash
# bootstrap.sh — turn a fresh Debian 12 VM into a Mobile CC capture host.
#
# Idempotent: re-running on an already-provisioned VM is a fast no-op
# (only re-runs the steps whose outputs are missing). Designed for
# `provision-vm.sh` to scp + execute, but works fine ssh'd in by hand.
#
# What this leaves on the VM:
#   /home/demo/                          ← cwd for everything
#   /usr/local/bin/mobile-cc             ← pinned release binary
#   /home/demo/mobile-cc-demos/          ← this repo's `demos/` tree
#   /tmp/demo-workspace/                 ← the demo pane's cwd
#   ~/.claude/projects/-tmp-demo-workspace/demo.jsonl
#                                        ← fixture (so ttyview-cc plugin
#                                          finds a transcript when
#                                          /tmp/demo-workspace is the
#                                          pane's cwd)
#   systemd user unit `mobile-cc-demo.service`
#                                        ← runs mobile-cc bound to
#                                          127.0.0.1:7800, survives logout
#   tmux session `demo`                  ← contains the capture pane,
#                                          bash with the mock TUI text
#                                          cat'd in so cell-grid view
#                                          shows something CC-shaped

set -euo pipefail

# --- knobs (override via env) -----------------------------------------------

MOBILE_CC_VERSION="${MOBILE_CC_VERSION:-v0.1.3}"
DEMO_USER="${DEMO_USER:-demo}"
WORKSPACE="${WORKSPACE:-/tmp/demo-workspace}"
DAEMON_PORT="${DAEMON_PORT:-7800}"

# Identity check — refuses to run as a user whose home has 'eyalev' in
# the path. Cheap safeguard against bootstrapping the dev machine by
# accident. Override with FORCE=1 if you really know what you're doing.
if [ "${FORCE:-0}" != "1" ] && echo "$HOME" | grep -qi 'eyalev'; then
  echo "ERROR: bootstrap.sh refuses to run on a host whose \$HOME ($HOME) contains 'eyalev'." >&2
  echo "       This script is meant for the dedicated GCP capture VM, not the dev box." >&2
  echo "       Set FORCE=1 to override (don't)." >&2
  exit 1
fi

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

# --- 1. apt deps ------------------------------------------------------------

log "apt install (tmux, ffmpeg, imagemagick, chromium deps)"
sudo apt-get update -qq
sudo apt-get install -y -qq \
  tmux ffmpeg curl ca-certificates git imagemagick \
  libnss3 libxss1 libatk-bridge2.0-0 libdrm2 libgtk-3-0 libgbm1 libasound2

# --- 2. Node 22 (NodeSource) for Playwright --------------------------------

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v22'; then
  log "install Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
log "node $(node -v)"

# --- 3. mobile-cc binary at a pinned release -------------------------------

if ! command -v mobile-cc >/dev/null 2>&1 \
   || ! mobile-cc --version 2>/dev/null | grep -q "${MOBILE_CC_VERSION#v}"; then
  log "install mobile-cc ${MOBILE_CC_VERSION}"
  TAR=$(mktemp -d)
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  TARGET=x86_64-unknown-linux-gnu ;;
    aarch64) TARGET=aarch64-unknown-linux-gnu ;;
    *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
  esac
  URL="https://github.com/eyalev/mobile-cc/releases/download/${MOBILE_CC_VERSION}/mobile-cc-${MOBILE_CC_VERSION}-${TARGET}.tar.gz"
  curl -fsSL "$URL" -o "$TAR/mobile-cc.tgz"
  tar -C "$TAR" -xzf "$TAR/mobile-cc.tgz"
  # The tarball layout has a single directory inside.
  sudo install -m 0755 "$(find "$TAR" -name mobile-cc -type f | head -1)" /usr/local/bin/mobile-cc
  rm -rf "$TAR"
fi
mobile-cc --version || true

# --- 4. demos pipeline (clone this repo, frozen to the release tag) --------

if [ ! -d "$HOME/mobile-cc-demos" ]; then
  log "clone mobile-cc @ ${MOBILE_CC_VERSION}"
  git clone --depth 1 --branch "$MOBILE_CC_VERSION" \
    https://github.com/eyalev/mobile-cc.git "$HOME/mobile-cc-demos"
fi

# --- 5. Playwright + chromium ----------------------------------------------

cd "$HOME/mobile-cc-demos/demos"
if [ ! -d node_modules/playwright ]; then
  log "npm install playwright"
  npm install --no-audit --no-fund --silent
fi
if [ ! -d "$HOME/.cache/ms-playwright" ] || [ -z "$(ls -A "$HOME/.cache/ms-playwright" 2>/dev/null)" ]; then
  log "playwright browser install"
  npx playwright install chromium >/dev/null
fi

# --- 6. fixture pane setup -------------------------------------------------

log "set up fixture workspace + JSONL"
mkdir -p "$WORKSPACE"
ENCODED="$(printf '%s' "$WORKSPACE" | tr '/' '-')"
mkdir -p "$HOME/.claude/projects/$ENCODED"
cp "$HOME/mobile-cc-demos/demos/fixtures/cc-transcript.jsonl" \
   "$HOME/.claude/projects/$ENCODED/demo.jsonl"

# --- 7. systemd user unit: mobile-cc on 127.0.0.1:$DAEMON_PORT -------------

log "install mobile-cc-demo systemd user unit"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/mobile-cc-demo.service" <<UNIT
[Unit]
Description=Mobile CC daemon (loopback) for the demo capture pane
After=default.target

[Service]
Type=simple
# Loopback bind only — capture script runs on this VM, so external
# reachability isn't needed. No TLS, no Tailscale, no Cloudflare tunnel.
ExecStart=/usr/local/bin/mobile-cc --bind 127.0.0.1:${DAEMON_PORT} --app-name "Mobile Claude Code"
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now mobile-cc-demo.service
sudo loginctl enable-linger "$DEMO_USER" || true

# --- 8. demo tmux session --------------------------------------------------

log "set up demo tmux session"
if tmux has-session -t demo 2>/dev/null; then
  tmux kill-session -t demo
fi
tmux new-session -d -s demo -c "$WORKSPACE" 'bash --norc -i'
# Pre-populate with mock CC TUI text — cell-grid view will render this
# as the "before" state of the paste flow.
tmux send-keys -t demo "clear && cat $HOME/mobile-cc-demos/demos/fixtures/cc-tui-mock.txt" Enter
sleep 1
PANE_ID=$(tmux list-panes -t demo:0 -F '#{pane_id}')
echo "$PANE_ID" > "$HOME/.demo-pane-id"
log "demo pane id: $PANE_ID  (saved to ~/.demo-pane-id)"

# --- 9. health check -------------------------------------------------------

log "wait for mobile-cc daemon to bind"
for i in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:${DAEMON_PORT}/healthz"; then
    log "daemon ready on :${DAEMON_PORT}"
    break
  fi
  sleep 0.5
done

cat <<DONE

Bootstrap done.

To capture:
  cd ~/mobile-cc-demos/demos
  TTV_PANE=\$(cat ~/.demo-pane-id) MOBILE_CC_URL=http://127.0.0.1:${DAEMON_PORT}/ npm run capture

Outputs land in ~/mobile-cc-demos/demos/dist/.
DONE
