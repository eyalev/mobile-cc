#!/usr/bin/env bash
# Single entrypoint for the demos-as-tests suite. Each demo is reproducible:
# re-running it regenerates its media AND asserts the workflow still works
# (a failing validate() fails the run). See demos/CONVENTIONS.md.
#
#   demos/run.sh                 # run every demo (the regression suite)
#   demos/run.sh all             # same
#   demos/run.sh <id>            # one demo by id (see --list)
#   demos/run.sh --list          # list registered demos
#
# UI demos need a running mobile-cc daemon (MOBILE_CC_URL, default
# https://127.0.0.1:7800/) whose capture pane (TTV_PANE) runs seeded content.
# Terminal demos are self-contained (they run the real install paths in a
# temp prefix). Both write their committed assets under docs/media/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
MANIFEST="$HERE/manifest.json"

# Tiny manifest query helper (node is the one guaranteed runtime here).
q() {
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const cmd = process.argv[2], arg = process.argv[3];
    const ds = m.demos;
    if (cmd === "list") { for (const d of ds) console.log([d.kind, d.id, d.media || "-", d.title].join("\t")); }
    if (cmd === "ids")  { console.log(ds.map(d => d.id).join(" ")); }
    if (cmd === "kind") { const d = ds.find(x => x.id === arg); process.stdout.write(d ? d.kind : ""); }
    if (cmd === "has")  { process.stdout.write(ds.some(x => x.id === arg) ? "1" : ""); }
    if (cmd === "url")  { const d = ds.find(x => x.id === arg); process.stdout.write((d && d.attachment_url) || ""); }
  ' "$MANIFEST" "$@"
}

arg="${1:-all}"
if [ "$arg" = "--list" ] || [ "$arg" = "list" ]; then
  printf 'KIND\tID\tMEDIA\tTITLE\n'
  q list
  exit 0
fi

if [ "$arg" = "all" ]; then
  TARGETS="$(q ids)"
else
  [ -n "$(q has "$arg")" ] || { echo "unknown demo: $arg (try: demos/run.sh --list)" >&2; exit 2; }
  TARGETS="$arg"
fi

UI=()
TERM=()
for id in $TARGETS; do
  case "$(q kind "$id")" in
    ui)       UI+=("$id") ;;
    terminal) TERM+=("$id") ;;
    *)        echo "demo '$id' has unknown kind" >&2; exit 2 ;;
  esac
done

rc=0
if [ "${#UI[@]}" -gt 0 ]; then
  echo "==> UI demos: ${UI[*]}"
  node runner/run-all.mjs "${UI[@]}" || rc=$?
fi
for id in "${TERM[@]}"; do
  echo "==> terminal demo: $id"
  bash "terminal/$id.sh" || rc=$?
done

echo
echo "done (exit $rc)."
echo "if an mp4 changed, re-upload it to GitHub user-attachments and update the"
echo "URL in README.md + manifest.json (see demos/CONVENTIONS.md). current URLs:"
for id in $TARGETS; do
  url="$(q url "$id")"
  [ -n "$url" ] && echo "  $id -> $url"
done
exit $rc
