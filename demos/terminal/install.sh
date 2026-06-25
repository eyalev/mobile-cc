#!/usr/bin/env bash
# Record the `curl … | bash` install flow as docs/media/install.{gif,mp4,png}.
# Reproducible — re-run after install.sh / the release flow changes.
# Needs: asciinema (>=3) + agg + ffmpeg.
#
# SAFETY: this runs the REAL installer (genuine download from GitHub Releases +
# minisign + SHA-256 verification) but with MOBILE_CC_SKIP_UNIT=1 and a temp
# prefix, so it does NOT touch the live ~/.local/bin/mobile-cc binary or the
# systemd service. Running the full systemd path would (a) replace the live
# binary with the released one and (b) re-bake the config-dir, resetting any
# hot-deployed plugins — so we deliberately avoid it here.
#
# High font size => crisp text after gif->mp4 downscale on GitHub.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"   # demos/terminal/ → repo root
# GIF is an INTERMEDIATE only (agg emits gif; we transcode to mp4 and never
# commit a gif — autoplay is bad UX). Lives in a temp file, cleaned up below.
OUT="$(mktemp --suffix=.gif)"
OUT_MP4="$ROOT/docs/media/install.mp4"
OUT_POSTER="$ROOT/docs/media/install.png"

for t in asciinema agg ffmpeg; do command -v "$t" >/dev/null || { echo "need $t" >&2; exit 1; }; done

CAST="$(mktemp --suffix=.cast)"
PAYLOAD="$(mktemp --suffix=.sh)"
# Clean, readable prefix (shows up in install.sh's "start it with:" hint).
# Safe — NOT the live ~/.local/bin.
DEMO_PREFIX="/tmp/mobile-cc/bin"
mkdir -p "$DEMO_PREFIX"
trap 'rm -rf "$CAST" "$PAYLOAD" "$OUT" /tmp/mobile-cc' EXIT

cat > "$PAYLOAD" <<DEMO
export MOBILE_CC_SKIP_UNIT=1
export MOBILE_CC_PREFIX="$DEMO_PREFIX"
export MOBILE_CC_TUNNEL=skip
P=\$'\033[1;32m~\033[0m \$ '
prompt(){ printf '%s%s\n' "\$P" "\$1"; sleep 0.5; }
clear
prompt 'curl -fsSL https://mobile-cc.dev/install.sh | bash'
curl -fsSL https://mobile-cc.dev/install.sh | bash
sleep 1
printf '\n'
prompt 'mobile-cc --version'
"$DEMO_PREFIX/mobile-cc" --version
sleep 2
DEMO

echo "recording..."
asciinema rec --overwrite --window-size 104x26 -c "bash $PAYLOAD" "$CAST"

echo "rendering gif (high-res for crisp text)..."
agg --theme asciinema --font-size 24 --idle-time-limit 2 --last-frame-duration 3 "$CAST" "$OUT"

echo "rendering mp4..."
ffmpeg -y -loglevel error -i "$OUT" \
  -movflags +faststart -c:v libx264 -crf 18 -pix_fmt yuv420p \
  -vf "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2" "$OUT_MP4"

echo "extracting poster (final frame)..."
N=$(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$OUT")
ffmpeg -y -loglevel error -i "$OUT" -vf "select=eq(n\,$((N-1)))" -frames:v 1 "$OUT_POSTER"

echo "wrote:"
echo "  $OUT_MP4"
echo "  $OUT_POSTER"
