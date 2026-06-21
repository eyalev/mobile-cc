#!/usr/bin/env bash
# Deploy the mobile-cc.dev static site to Cloudflare Pages.
#
# Since binaries moved to GitHub Releases (see ../install.sh), this site is
# just two files: the landing page and the installer. No version dirs, no
# latest.txt — those used to be hand-mirrored here and are gone.
#
# Cloudflare Pages deploys replace the WHOLE site, so the staging dir below
# IS the entire site. Requires wrangler (OAuth-authed).
#
#   ./pages/deploy.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

cp "$HERE/index.html"   "$STAGING/index.html"
cp "$ROOT/install.sh"   "$STAGING/install.sh"

echo "Staging mobile-cc.dev:"
ls -la "$STAGING"
echo

wrangler pages deploy "$STAGING" \
  --project-name=mobile-cc \
  --branch=main \
  --commit-dirty=true
