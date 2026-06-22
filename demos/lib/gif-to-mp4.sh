#!/usr/bin/env bash
# Convert a GIF to a web-friendly mp4 (h264 / yuv420p / even dims / faststart)
# suitable for embedding as a GitHub video player.
#
# Usage: demos/lib/gif-to-mp4.sh <in.gif> <out.mp4>
#
# Note on README embedding: GitHub strips hand-written <video> tags, so the
# mp4 must be uploaded through GitHub's web composer to get a
# github.com/user-attachments/assets/<uuid> URL (auto-rendered as a player).
# See demos/terminal/brew-install.sh and issue #1 for the workflow.
set -euo pipefail
IN="${1:?usage: $0 <in.gif> <out.mp4>}"
OUT="${2:?usage: $0 <in.gif> <out.mp4>}"

ffmpeg -y -loglevel error -i "$IN" \
  -movflags +faststart -c:v libx264 -crf 20 -pix_fmt yuv420p \
  -vf "fps=20,scale=trunc(iw/2)*2:trunc(ih/2)*2" "$OUT"

echo "wrote $OUT"
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,pix_fmt -of default=noprint_wrappers=1 "$OUT"
