#!/usr/bin/env bash
# Capture a UI demo locally against an ISOLATED, synthetic mobile-cc daemon —
# no GCP VM, no touching the live :7800 service, no real sessions leaked.
#
#   demos/local-capture.sh <demo-id>
#
# It stands up a throwaway daemon on a dedicated tmux socket + port + config
# dir, seeds the demo's PROFILE (projects / sessions / mock content / pinned
# project-grouped tabs — see demos/profiles/ and CONVENTIONS.md "Profiles"),
# runs the demo's workflow capture against it, and tears everything down.
#
# Privacy: --tmux-socket scopes the daemon to ONLY the synthetic sessions, so
# the pane picker never sees your real tmux server (verified: 60 real sessions
# → 0 leaked). Content is fixtures only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ID="${1:?usage: demos/local-capture.sh <demo-id>}"

SOCK="mcc-democap"
PORT="${MCC_DEMO_PORT:-7899}"
# Sandboxed throwaway $HOME so captured shells render REALISTIC paths: a session
# whose cwd is $SANDBOX/projects/api tilde-compresses to ~/projects/api against
# this HOME, while the real dir stays isolated here and is cleaned up on exit.
# Nothing in frame is ever a /tmp path (per mcc-manager de-/tmp directive). The
# create-project dialog (which requires an absolute path) shows the absolute
# sandbox path, never /tmp.
REAL_HOME="$HOME"
SANDBOX="${MCC_DEMO_HOME:-$REAL_HOME/.cache/mobile-cc/demo-home}"
export HOME="$SANDBOX"
export MCC_DEMO_HOME="$SANDBOX"   # tabs-projects.mjs reads this for the new-project path
# The Playwright capture process inherits this sandbox HOME too, so point it
# back at the REAL browser cache (else it can't find its chromium under $HOME).
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$REAL_HOME/.cache/ms-playwright}"
BASE="$SANDBOX/projects"
CFG="/tmp/mcc-democap-config"
DPID=""

cleanup() {
  [ -n "$DPID" ] && kill "$DPID" 2>/dev/null || true
  tmux -L "$SOCK" kill-server 2>/dev/null || true
  # Guard: only remove the sandbox when it's the expected deep throwaway path
  # under the real home's cache — never a bare/short path.
  case "$SANDBOX" in
    "$REAL_HOME"/.cache/mobile-cc/*) rm -rf "$SANDBOX" 2>/dev/null || true ;;
  esac
  rm -rf "$CFG" 2>/dev/null || true
}
trap cleanup EXIT

# Which profile does this demo use? (manifest entry's `profile`; empty = a
# single bare `demo` session with the default mock.)
PROFILE="$(node -e '
  const fs=require("fs");
  const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const d=m.demos.find(x=>x.id===process.argv[2]);
  process.stdout.write((d&&d.profile)||"");
' "$HERE/manifest.json" "$ID")"

tmux -L "$SOCK" kill-server 2>/dev/null || true
rm -rf "$SANDBOX" "$CFG"; mkdir -p "$BASE" "$CFG"
# Minimal rc so plugin-created shells (the blank New-Tab session, the new
# project) show a clean `\w` prompt — i.e. ~ or ~/projects/<name> — instead of
# inheriting a noisy real prompt (git branch / timestamp) or leaking real $HOME.
cat > "$SANDBOX/.bashrc" <<'RC'
PS1='\w \$ '
RC

seed_session() { # <session> <cwd-subdir> <mock-file>
  local sess="$1" cwd="$BASE/$2" mock="$3"
  mkdir -p "$cwd"
  local enc; enc="$(printf '%s' "$cwd" | tr '/' '-')"
  mkdir -p "$HOME/.claude/projects/$enc"
  cp "$HERE/fixtures/cc-transcript.jsonl" "$HOME/.claude/projects/$enc/demo.jsonl"
  tmux -L "$SOCK" new-session -d -s "$sess" -c "$cwd" 'bash --norc -i'
  # `read` after the cat keeps the pane on the rendered content (no shell
  # prompt creeping into frame) without burning CPU on a sleep loop.
  tmux -L "$SOCK" send-keys -t "$sess" "clear && cat $HERE/fixtures/$mock && read -r _" Enter
}

if [ -n "$PROFILE" ]; then
  echo "==> profile: $PROFILE"
  while IFS=$'\t' read -r tag a b c; do
    case "$tag" in
      S) seed_session "$a" "$b" "$c" ;;
      A) ACTIVE_SESSION="$a" ;;
    esac
  done < <(node "$HERE/lib/profile.mjs" plan "$PROFILE")
else
  echo "==> no profile; single 'demo' session"
  seed_session demo demo cc-tui-mock.txt
  ACTIVE_SESSION=demo
fi
sleep 1

echo "==> starting isolated daemon on :$PORT (socket $SOCK)"
# Launch the daemon FROM the sandbox so any session it spawns without an
# explicit cwd (the blank New-Tab) inherits ~ instead of the repo dir.
( cd "$SANDBOX" && exec mobile-cc --tmux-socket "$SOCK" --bind "127.0.0.1:$PORT" --config-dir "$CFG" \
  --app-name "Mobile Claude Code" >/tmp/mcc-democap-daemon.log 2>&1 ) &
DPID=$!
for i in $(seq 1 60); do curl -fsk -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null && break; sleep 0.25; done

# Optional plugin overlay: drop fixed-but-not-yet-baked plugin JS into
# demos/_overrides/*.js to capture a demo against in-flight UX before mcc-build
# bakes it. No-op when the dir is absent (so other demos are unaffected). The
# daemon installs its plugins to $CFG/plugins on startup and serves them
# per-request from there, so overwriting after healthz takes effect immediately.
if compgen -G "$HERE/_overrides/*.js" >/dev/null 2>&1; then
  for i in $(seq 1 40); do [ -f "$CFG/plugins/installed.json" ] && break; sleep 0.25; done
  for f in "$HERE/_overrides"/*.js; do cp "$f" "$CFG/plugins/" && echo "==> overlay $(basename "$f")"; done
fi
# Pre-create demo project folders the "create a project" beat points at — the
# prod capture binary still requires the cwd to exist (the mkdir-on-create fix
# is server-side and not in this binary). Cleaned up with $BASE by the trap.
mkdir -p "$BASE/payments" 2>/dev/null || true

if [ -n "$PROFILE" ]; then
  ACTIVE_PANE="$(node "$HERE/lib/profile.mjs" pins "$PROFILE" "http://127.0.0.1:$PORT")"
else
  ACTIVE_PANE="$(curl -fsk "http://127.0.0.1:$PORT/panes" | node -e 'const d=JSON.parse(require("fs").readFileSync(0));process.stdout.write((d.find(p=>p.session==="demo")||d[0]).id)')"
fi
echo "==> active session $ACTIVE_SESSION → pane $ACTIVE_PANE"

echo "==> capturing $ID"
( cd "$HERE" && MOBILE_CC_URL="http://127.0.0.1:$PORT/" TTV_PANE="$ACTIVE_PANE" node runner/run-all.mjs "$ID" )
echo "==> done"
