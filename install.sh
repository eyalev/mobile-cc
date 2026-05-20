#!/usr/bin/env bash
# mobile-cc installer
#
# Source of truth: https://github.com/eyalev/mobile-cc/blob/main/install.sh
# Live URL:        https://mobile-cc.dev/install.sh
# Pages fallback:  https://mobile-cc.pages.dev/install.sh
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

# ---------- preflight: loopback-only policy ----------
# mobile-cc has no built-in authentication. Since v0.2.0 the binary refuses
# to bind any non-loopback address — the safe ways to reach it from another
# device all involve a fronting layer that provides auth (ssh -L, Tailscale,
# cloudflared, reverse proxy with auth). See the README section linked below.
case "$BIND" in
  127.0.0.1:*|localhost:*|\[::1\]:*)
    : # loopback — proceed
    ;;
  *)
    cat >&2 <<REFUSE

  mobile-cc only binds 127.0.0.1.

  MOBILE_CC_BIND='$BIND' is non-loopback. The installer won't proceed —
  the daemon would refuse to start anyway.

  To reach mobile-cc from another device, see:
    https://github.com/eyalev/mobile-cc#reaching-mobile-cc-from-elsewhere

REFUSE
    exit 1
    ;;
esac

# ---------- preflight: tmux is a runtime prerequisite ----------
# mobile-cc attaches to your existing tmux server; it doesn't bundle or start
# one. If tmux is missing, the daemon still runs but /panes returns empty.
# Warn so users notice before opening the URL on their phone.
if ! command -v tmux >/dev/null 2>&1; then
  echo "mobile-cc: warning — tmux is not on PATH."
  echo "  Without tmux, mobile-cc starts but has nothing to attach to. Install it:"
  case "$(uname -s)" in
    Linux)
      if   command -v apt-get >/dev/null 2>&1; then echo "    sudo apt-get install -y tmux"
      elif command -v dnf >/dev/null 2>&1;     then echo "    sudo dnf install -y tmux"
      elif command -v pacman >/dev/null 2>&1;  then echo "    sudo pacman -S tmux"
      elif command -v apk >/dev/null 2>&1;     then echo "    sudo apk add tmux"
      else                                          echo "    (use your distro's package manager)"
      fi
      ;;
    Darwin) echo "    brew install tmux" ;;
    *)      echo "    (install tmux via your platform's package manager)" ;;
  esac
  echo "  Continuing — install mobile-cc anyway, then start a tmux session before opening the URL."
  echo
fi

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

  # Verify the downloaded tarball against the published .sha256. Pages
  # publishes <asset>.sha256 alongside each tarball — fetching it on the
  # same TLS connection means an attacker controlling the network can't
  # serve a tampered binary + matching hash unless they also break TLS.
  echo "      verifying sha256..."
  if curl -fsSL --max-time 30 "${URL}.sha256" -o "$TMP/dl.tar.gz.sha256"; then
    expected=$(awk '{print $1}' "$TMP/dl.tar.gz.sha256")
    if   command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$TMP/dl.tar.gz" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$TMP/dl.tar.gz" | awk '{print $1}')
    else
      echo "mobile-cc: WARNING — neither sha256sum nor shasum found; skipping integrity check." >&2
      actual="$expected"  # skip the comparison below
    fi
    if [ "$expected" != "$actual" ]; then
      echo "" >&2
      echo "mobile-cc: SHA-256 mismatch on downloaded binary!" >&2
      echo "  expected: $expected" >&2
      echo "  actual:   $actual" >&2
      echo "  url:      $URL" >&2
      echo "" >&2
      echo "Refusing to install. This could be a corrupted download, or someone" >&2
      echo "tampering with the network path. Re-run; if it persists, file an" >&2
      echo "issue at https://github.com/eyalev/mobile-cc/issues ." >&2
      exit 1
    fi
  else
    echo "mobile-cc: WARNING — could not fetch .sha256 sibling; skipping integrity check." >&2
  fi

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

# ---------- tunnel picker ----------
# Offer a one-keystroke "now make this reachable from my phone" path.
#
# Only Tailscale is wired in here. We deliberately don't offer a bare
# Cloudflare quick tunnel: it produces a public *.trycloudflare.com URL,
# and mobile-cc has no built-in auth — anyone who learns the URL can
# drive your tmux. If you want public exposure, put auth in front:
# a Cloudflare *named* tunnel + Cloudflare Access (email SSO), or a
# reverse proxy with basic-auth / oauth2-proxy. Don't expose mobile-cc
# directly to the public internet.
#
# Skip when:
#   - $MOBILE_CC_TUNNEL is set (non-interactive automation;
#     supported values: tailscale, skip).
#   - stdout is not a tty AND $MOBILE_CC_TUNNEL is unset (no way to
#     prompt; print hints + exit).
#
# (The non-loopback branch is gone — installer exits earlier in that case.)
PORT="${BIND##*:}"

print_tailscale_hint() {
  echo
  if command -v tailscale >/dev/null 2>&1; then
    HOST=$(tailscale status --self --json 2>/dev/null | grep -oE '"DNSName":\s*"[^"]+' | head -1 | sed 's/.*"//; s/\.$//')
    if [ -n "$HOST" ]; then
      echo "    👉 reach mobile-cc from any device on your tailnet at:"
      echo "       http://${HOST}:${PORT}/"
    else
      echo "    Tailscale detected but couldn't resolve this host's tailnet name."
      echo "    Try: tailscale status"
    fi
  else
    echo "    Tailscale not installed. To use this path:"
    echo "      curl -fsSL https://tailscale.com/install.sh | sh"
    echo "      sudo tailscale up"
    echo "    Then visit http://<this-machine>.<tailnet>.ts.net:${PORT}/ from your phone."
  fi
}

prompt_tunnel() {
  echo "    How do you want to reach this from your phone?"
  echo "      1) Tailscale  — best for personal use, encrypted, free"
  echo "      2) Skip       — I'll set up access myself"
  echo
  echo "    (For public exposure, put auth in front: Cloudflare named tunnel"
  echo "    + Cloudflare Access, or oauth2-proxy. mobile-cc has no built-in"
  echo "    auth — don't expose its port directly to the internet.)"
  echo
  printf "    Choice [1/2]: "
  # Read from /dev/tty so this works when invoked via `curl | bash`
  # (stdin is the pipe, not the keyboard).
  exec </dev/tty
  read CHOICE
  case "$CHOICE" in
    1|"") echo; echo "    → Tailscale"; print_tailscale_hint ;;
    *)    echo; echo "    → skipped." ;;
  esac
}

case "${MOBILE_CC_TUNNEL:-}" in
  tailscale) print_tailscale_hint ;;
  skip)      : ;;
  "")
    if [ -t 1 ] && [ -r /dev/tty ]; then
      prompt_tunnel
    else
      echo "    Reach it from another device via:"
      echo "      • tailscale:  http://<this-machine>.<tailnet>.ts.net:${PORT}/"
      echo "      • ssh tunnel: ssh -L ${PORT}:${BIND} <this-host>"
      echo "      • more options: https://github.com/eyalev/mobile-cc#reaching-mobile-cc-from-elsewhere"
      echo "    (set MOBILE_CC_TUNNEL=tailscale|skip to choose non-interactively)"
    fi
    ;;
  cloudflare-quick)
    echo "    MOBILE_CC_TUNNEL=cloudflare-quick is no longer supported." >&2
    echo "    A bare Cloudflare quick tunnel publishes a public URL without auth" >&2
    echo "    in front of an auth-less daemon — anyone with the URL gets a shell." >&2
    echo "    Use a Cloudflare *named* tunnel + Cloudflare Access, or oauth2-proxy." >&2
    ;;
  *) echo "    unknown MOBILE_CC_TUNNEL=$MOBILE_CC_TUNNEL — skipping (use tailscale|skip)" ;;
esac
echo
echo "    survive logout:    loginctl enable-linger \$USER"
echo "    follow logs:       journalctl --user -u mobile-cc -f"
