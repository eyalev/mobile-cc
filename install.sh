#!/usr/bin/env bash
# mobile-cc installer
#
#   curl -fsSL https://mobile-cc.dev/install.sh | bash
#
# Knobs (env vars):
#   MOBILE_CC_BIND       — address:port to bind (default 127.0.0.1:7800)
#   MOBILE_CC_VERSION    — release tag to install (default: latest)
#   MOBILE_CC_PREFIX     — where to install the binary (default $HOME/.local/bin)
#   MOBILE_CC_BASE_URL   — install source base URL
#                          (default https://mobile-cc.dev, falls back to
#                           https://mobile-cc.pages.dev if the apex 404s)
#   MOBILE_CC_SKIP_UNIT  — set to 1 to skip the systemd user unit
#   MOBILE_CC_BIN_FILE   — install this local file instead of downloading
#                          (skips network entirely; for offline / test installs)
#
# Uninstall:
#   systemctl --user disable --now mobile-cc
#   rm -rf $HOME/.config/mobile-cc $HOME/.config/systemd/user/mobile-cc.service
#   rm -f  $HOME/.local/bin/mobile-cc

set -euo pipefail

BIND="${MOBILE_CC_BIND:-127.0.0.1:7800}"
PREFIX="${MOBILE_CC_PREFIX:-$HOME/.local/bin}"
UNIT_DIR="$HOME/.config/systemd/user"
BASE_URL="${MOBILE_CC_BASE_URL:-}"

mkdir -p "$PREFIX"

# ---------- acquire binary ----------
if [ -n "${MOBILE_CC_BIN_FILE:-}" ]; then
  if [ ! -f "$MOBILE_CC_BIN_FILE" ]; then
    echo "mobile-cc: MOBILE_CC_BIN_FILE='$MOBILE_CC_BIN_FILE' does not exist" >&2
    exit 1
  fi
  echo "[1/3] installing local binary from $MOBILE_CC_BIN_FILE"
  install -m 0755 "$MOBILE_CC_BIN_FILE" "$PREFIX/mobile-cc"
else
  # resolve target
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$OS-$ARCH" in
    linux-x86_64)               TARGET="x86_64-unknown-linux-gnu" ;;
    linux-aarch64|linux-arm64)  TARGET="aarch64-unknown-linux-gnu" ;;
    darwin-x86_64)              TARGET="x86_64-apple-darwin" ;;
    darwin-arm64)               TARGET="aarch64-apple-darwin" ;;
    *) echo "mobile-cc: unsupported platform $OS-$ARCH" >&2; exit 1 ;;
  esac

  # resolve base URL with fallback (apex CNAME may not be wired yet)
  resolve_base_url() {
    if [ -n "$BASE_URL" ]; then echo "$BASE_URL"; return; fi
    # try the apex first, then pages.dev as fallback
    for url in "https://mobile-cc.dev" "https://mobile-cc.pages.dev"; do
      if curl -fsSL --max-time 4 -o /dev/null "$url/latest.txt"; then
        echo "$url"
        return
      fi
    done
    echo ""
  }
  BASE_URL=$(resolve_base_url)
  if [ -z "$BASE_URL" ]; then
    echo "mobile-cc: cannot reach either mobile-cc.dev or mobile-cc.pages.dev" >&2
    echo "           set MOBILE_CC_BASE_URL=<url> to an install mirror" >&2
    exit 1
  fi

  # resolve version
  if [ -z "${MOBILE_CC_VERSION:-}" ]; then
    MOBILE_CC_VERSION=$(curl -fsSL --max-time 5 "$BASE_URL/latest.txt" | tr -d '[:space:]')
  fi
  if [ -z "$MOBILE_CC_VERSION" ]; then
    echo "mobile-cc: could not resolve latest version from $BASE_URL/latest.txt" >&2
    exit 1
  fi

  ASSET="mobile-cc-${MOBILE_CC_VERSION}-${TARGET}.tar.gz"
  URL="${BASE_URL}/${MOBILE_CC_VERSION}/${ASSET}"

  echo "[1/3] downloading mobile-cc ${MOBILE_CC_VERSION} (${TARGET}) from ${BASE_URL}"
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  curl -fSL --max-time 60 "$URL" -o "$TMP/dl.tar.gz"
  tar -xzf "$TMP/dl.tar.gz" -C "$TMP"
  BIN_SRC=$(find "$TMP" -maxdepth 2 -type f -perm -u+x ! -name '*.tar.gz' | head -1)
  if [ -z "$BIN_SRC" ]; then
    echo "mobile-cc: tarball did not contain an executable (got: $(ls "$TMP"))" >&2
    exit 1
  fi
  install -m 0755 "$BIN_SRC" "$PREFIX/mobile-cc"
fi

# ---------- systemd user unit ----------
if [ "${MOBILE_CC_SKIP_UNIT:-0}" != "1" ] && command -v systemctl >/dev/null 2>&1; then
  echo "[2/3] writing systemd user unit"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/mobile-cc.service" <<UNIT
[Unit]
Description=mobile-cc — drive Claude Code from a mobile browser
After=default.target

[Service]
Type=simple
ExecStart=$PREFIX/mobile-cc --bind $BIND --app-name "Mobile CC"
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now mobile-cc.service
  echo "      enabled + started (systemctl --user status mobile-cc)"
else
  echo "[2/3] systemd skipped; start manually with:"
  echo "      $PREFIX/mobile-cc --bind $BIND --app-name 'Mobile CC'"
fi

# ---------- done ----------
echo "[3/3] ready"
echo
echo "    mobile-cc is listening on http://${BIND}/"
echo
case "$BIND" in
  127.0.0.1:*|localhost:*)
    PORT="${BIND##*:}"
    echo "    bound to loopback. Reach it from your phone via one of:"
    echo "      • tailscale:  http://<this-machine>.<tailnet>.ts.net:${PORT}/"
    echo "      • ssh tunnel: ssh -L ${PORT}:${BIND} <this-host>"
    echo "      • cloudflared tunnel run"
    ;;
  *)
    echo "    bound publicly. Make sure the port is firewalled or behind Tailscale —"
    echo "    anyone who can reach it can drive your tmux."
    ;;
esac
echo
echo "    survive logout:    loginctl enable-linger \$USER"
echo "    follow logs:       journalctl --user -u mobile-cc -f"
