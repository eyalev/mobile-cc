#!/usr/bin/env bash
# Re-capture the 4 README stills (docs/media/{hero,sessions,chat,desktop}.png)
# against an ISOLATED synthetic mobile-cc daemon running the LIVE blue UI — no
# touching :7800, no real sessions. Mirrors local-capture.sh's daemon setup but
# forces the multi-project profile (project-grouped tabs) and runs the bespoke
# stills capture (demos/stills-readme.mjs) instead of a workflow.
#
#   demos/local-stills.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOCK="mcc-stillcap"; PORT="${MCC_DEMO_PORT:-7897}"
BASE="/tmp/mcc-stillcap-ws"; CFG="/tmp/mcc-stillcap-config"; DPID=""
PROFILE="multi-project"
cleanup() {
  [ -n "$DPID" ] && kill "$DPID" 2>/dev/null || true
  tmux -L "$SOCK" kill-server 2>/dev/null || true
  rm -rf "$BASE" "$CFG" "$HOME"/.claude/projects/-tmp-mcc-stillcap-ws-* 2>/dev/null || true
}
trap cleanup EXIT
tmux -L "$SOCK" kill-server 2>/dev/null || true
rm -rf "$BASE" "$CFG"; mkdir -p "$BASE" "$CFG"
seed_session() {
  local sess="$1" cwd="$BASE/$2" mock="$3"; mkdir -p "$cwd"
  local enc; enc="$(printf '%s' "$cwd" | tr '/' '-')"; mkdir -p "$HOME/.claude/projects/$enc"
  cp "$HERE/fixtures/cc-transcript.jsonl" "$HOME/.claude/projects/$enc/demo.jsonl"
  tmux -L "$SOCK" new-session -d -s "$sess" -c "$cwd" 'bash --norc -i'
  tmux -L "$SOCK" send-keys -t "$sess" "clear && cat $HERE/fixtures/$mock && read -r _" Enter
}
echo "==> profile: $PROFILE"
while IFS=$'\t' read -r tag a b c; do
  case "$tag" in S) seed_session "$a" "$b" "$c" ;; A) ACTIVE_SESSION="$a" ;; esac
done < <(node "$HERE/lib/profile.mjs" plan "$PROFILE")
sleep 1
echo "==> starting isolated daemon on :$PORT (socket $SOCK)"
mobile-cc --tmux-socket "$SOCK" --bind "127.0.0.1:$PORT" --config-dir "$CFG" \
  --app-name "Mobile Claude Code" >/tmp/mcc-stillcap-daemon.log 2>&1 &
DPID=$!
for i in $(seq 1 60); do curl -fsk -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null && break; sleep 0.25; done
ACTIVE_PANE="$(node "$HERE/lib/profile.mjs" pins "$PROFILE" "http://127.0.0.1:$PORT")"
echo "==> active pane $ACTIVE_PANE"
echo "==> capturing README stills"
( cd "$HERE" && MOBILE_CC_URL="http://127.0.0.1:$PORT/" TTV_PANE="$ACTIVE_PANE" node stills-readme.mjs )
echo "==> done"
