#!/usr/bin/env bash
# Record the `brew install eyalev/tap/mobile-cc` flow as
# docs/media/brew-install.gif. Reproducible — re-run after the tap or CLI
# changes. Needs: asciinema (>=3, for --window-size) + agg.
#
# Asset is DERIVED, not hand-edited (same philosophy as the other media).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$ROOT/docs/media/brew-install.gif"

command -v asciinema >/dev/null || { echo "need asciinema" >&2; exit 1; }
command -v agg >/dev/null || { echo "need agg" >&2; exit 1; }

CAST="$(mktemp --suffix=.cast)"
PAYLOAD="$(mktemp --suffix=.sh)"
trap 'rm -f "$CAST" "$PAYLOAD"' EXIT

# What runs inside the recording.
cat > "$PAYLOAD" <<'DEMO'
export HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_PATH_SHADOW_CHECK=1
# Suppress brew's untrusted-third-party-tap warning block (clutters the demo
# with unrelated taps on this machine; the install path itself is unchanged).
export HOMEBREW_NO_REQUIRE_TAP_TRUST=1
P=$'\033[1;32m~\033[0m $ '
prompt(){ printf '%s%s\n' "$P" "$1"; sleep 0.5; }
# start clean so the install actually runs on camera
brew untap eyalev/tap >/dev/null 2>&1 || true
brew uninstall mobile-cc >/dev/null 2>&1 || true
clear
prompt 'brew install eyalev/tap/mobile-cc'
brew install eyalev/tap/mobile-cc
# brew's bin is on a brew user's PATH; make `mobile-cc` resolve to it here too
export PATH="$(brew --prefix)/bin:$PATH"
sleep 1
printf '\n'
prompt 'mobile-cc --version'
mobile-cc --version
sleep 2
DEMO

echo "recording..."
asciinema rec --overwrite --window-size 80x22 -c "bash $PAYLOAD" "$CAST"

echo "rendering gif..."
agg --theme asciinema --font-size 14 --idle-time-limit 2 --last-frame-duration 3 "$CAST" "$OUT"

# leave the system clean
brew uninstall mobile-cc >/dev/null 2>&1 || true
brew untap eyalev/tap >/dev/null 2>&1 || true

echo "wrote $OUT"
