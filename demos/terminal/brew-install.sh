#!/usr/bin/env bash
# Record the `brew install eyalev/tap/mobile-cc` flow as
# docs/media/brew-install.gif. Reproducible — re-run after the tap or CLI
# changes. Needs: asciinema (>=3, for --window-size) + agg.
#
# Asset is DERIVED, not hand-edited (same philosophy as the other media).
#
# NOTE on the README player: GitHub strips hand-written <video> tags, so the
# README embeds the mp4 via a GitHub *user-attachments* URL (auto-rendered as
# an inline player). That URL is created by UPLOADING the mp4 through GitHub's
# web composer (drag it into an issue/comment), which only goes public once the
# content is posted (see issue #1, which hosts it — don't delete that issue).
# So after regenerating brew-install.mp4 here, re-upload it and update the URL
# in README.md. The .gif/.png remain useful as standalone/source artifacts.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"   # demos/terminal/ → repo root
# GIF is an INTERMEDIATE only (agg emits gif; we transcode to mp4 and never
# commit a gif — autoplay is bad UX). Temp file, cleaned up below.
OUT="$(mktemp --suffix=.gif)"
OUT_MP4="$ROOT/docs/media/brew-install.mp4"
OUT_POSTER="$ROOT/docs/media/brew-install.png"

command -v asciinema >/dev/null || { echo "need asciinema" >&2; exit 1; }
command -v agg >/dev/null || { echo "need agg" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "need ffmpeg" >&2; exit 1; }

CAST="$(mktemp --suffix=.cast)"
PAYLOAD="$(mktemp --suffix=.sh)"
trap 'rm -f "$CAST" "$PAYLOAD" "$OUT"' EXIT

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

echo "rendering mp4 (player with controls)..."
# Derive the mp4 from the gif so timing matches exactly. yuv420p + even
# dimensions = broad compatibility (GitHub player, Safari, QuickTime).
ffmpeg -y -loglevel error -i "$OUT" \
  -movflags +faststart -c:v libx264 -crf 20 -pix_fmt yuv420p \
  -vf "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2" "$OUT_MP4"

echo "extracting poster (final frame)..."
N=$(ffprobe -v error -select_streams v:0 -count_frames \
     -show_entries stream=nb_read_frames -of csv=p=0 "$OUT")
ffmpeg -y -loglevel error -i "$OUT" -vf "select=eq(n\,$((N-1)))" -frames:v 1 "$OUT_POSTER"

# leave the system clean
brew uninstall mobile-cc >/dev/null 2>&1 || true
brew untap eyalev/tap >/dev/null 2>&1 || true

echo "wrote:"
echo "  $OUT_MP4"
echo "  $OUT_POSTER"
