#!/usr/bin/env bash
# mobile-cc installer
#
# Source of truth: https://github.com/eyalev/mobile-cc/blob/main/install.sh
# Live URL:        https://mobile-cc.dev/install.sh
#
#   curl -fsSL https://mobile-cc.dev/install.sh | bash
#
# Prefer to read before you run (recommended — this script installs a binary
# that can drive your shell):
#
#   curl -fsSL https://mobile-cc.dev/install.sh -o mobile-cc-install.sh
#   less mobile-cc-install.sh        # audit it
#   bash mobile-cc-install.sh
#
# Binaries are served straight from GitHub Releases. The download is verified,
# in order of strength: a minisign signature (if `minisign` is installed),
# GitHub build-provenance / SLSA attestation (if `gh` is installed + authed),
# and always a SHA-256 checksum. See "verify" below.
#
# Knobs (env vars):
#   MOBILE_CC_BIND       — address:port to bind (default 127.0.0.1:7800)
#   MOBILE_CC_VERSION    — release tag to install (default: latest)
#   MOBILE_CC_PREFIX     — where to install the binary (default $HOME/.local/bin)
#   MOBILE_CC_REPO       — GitHub owner/repo to fetch from (default eyalev/mobile-cc)
#   MOBILE_CC_RELEASES_URL — release base URL (default https://github.com/$REPO/releases)
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
REPO="${MOBILE_CC_REPO:-eyalev/mobile-cc}"
RELEASES_URL="${MOBILE_CC_RELEASES_URL:-https://github.com/${REPO}/releases}"

# minisign public key for mobile-cc release artifacts. If `minisign` is on the
# user's PATH and the release ships a .minisig, the download is verified against
# this key (authenticity, no `gh` required). Generated 2026-06-21; rotating it
# means shipping a new install.sh.
MINISIGN_PUBKEY="RWSlxyi2aX3154lzQAyvgiOFtsZOgnlfsEkdlwTDPYI2aV72b6FBqqp1"

mkdir -p "$PREFIX"

# ---------- preflight: loopback-only policy ----------
# mobile-cc has no built-in authentication. Since v0.2.0 the binary refuses
# to bind any non-loopback address — the safe ways to reach it from another
# device all involve a fronting layer that provides auth (ssh -L, Tailscale,
# cloudflared, reverse proxy with auth). See the README section linked below.
# Reject any BIND containing characters outside a safe host:port set (spaces,
# newlines, shell/unit-file metacharacters). The loopback glob below is not a
# sufficient sanitizer on its own — `127.0.0.1:*` would also match
# `127.0.0.1:7800 --some-flag` — and $BIND is later interpolated unquoted into
# the systemd unit's ExecStart, so an unsanitized value could inject extra CLI
# flags or unit directives.
case "$BIND" in
  *[!0-9A-Za-z.:_\[\]-]*)
    echo "mobile-cc: MOBILE_CC_BIND='$BIND' contains invalid characters." >&2
    exit 1
    ;;
esac
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

  # Binaries live on GitHub Releases. Asset names are version-less
  # (mobile-cc-<target>.tar.gz) so the "latest" URL needs no version lookup:
  #   latest:  $RELEASES_URL/latest/download/<asset>
  #   pinned:  $RELEASES_URL/download/<tag>/<asset>
  ASSET="mobile-cc-${TARGET}.tar.gz"
  if [ -n "${MOBILE_CC_VERSION:-}" ]; then
    URL="${RELEASES_URL}/download/${MOBILE_CC_VERSION}/${ASSET}"
    # Releases up to v0.4.0 embedded the version in the asset name; fall back
    # to that scheme if the version-less name isn't present.
    URL_FALLBACK="${RELEASES_URL}/download/${MOBILE_CC_VERSION}/mobile-cc-${MOBILE_CC_VERSION}-${TARGET}.tar.gz"
    VERSION_LABEL="$MOBILE_CC_VERSION"
  else
    URL="${RELEASES_URL}/latest/download/${ASSET}"
    URL_FALLBACK=""
    VERSION_LABEL="latest"
  fi

  echo "[1/3] downloading mobile-cc ${VERSION_LABEL} (${TARGET})"
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  if curl -fsSL --max-time 60 "$URL" -o "$TMP/dl.tar.gz" 2>/dev/null; then
    echo "      from ${URL}"
  elif [ -n "$URL_FALLBACK" ] && curl -fsSL --max-time 60 "$URL_FALLBACK" -o "$TMP/dl.tar.gz" 2>/dev/null; then
    URL="$URL_FALLBACK"
    echo "      from ${URL}"
  else
    echo "mobile-cc: download failed from ${URL}" >&2
    [ -n "$URL_FALLBACK" ] && echo "           (also tried ${URL_FALLBACK})" >&2
    exit 1
  fi

  # ---------- verify the download (layered: strongest available wins) ----------
  # 1. minisign signature  — authenticity, no `gh` needed (presence-gated on
  #    both the minisign tool and a .minisig sibling; a present-but-bad sig is
  #    fatal).
  # 2. gh build-provenance — proves the binary came from this repo's CI
  #    (SLSA). Best-effort: a failure is a notice, not fatal, so installs of
  #    releases that predate attestations still work.
  # 3. SHA-256 checksum    — integrity baseline; always attempted; a mismatch
  #    is always fatal.
  STRONG_VERIFIED=0

  fatal_verify() {
    echo "" >&2
    echo "mobile-cc: $1" >&2
    echo "  url: $URL" >&2
    echo "" >&2
    echo "Refusing to install. This could be a corrupted download, or someone" >&2
    echo "tampering with the artifact. Re-run; if it persists, file an issue at" >&2
    echo "https://github.com/${REPO}/issues ." >&2
    exit 1
  }

  # 1. minisign
  if command -v minisign >/dev/null 2>&1; then
    if curl -fsSL --max-time 30 "${URL}.minisig" -o "$TMP/dl.tar.gz.minisig" 2>/dev/null; then
      echo "      verifying minisign signature..."
      if minisign -Vm "$TMP/dl.tar.gz" -P "$MINISIGN_PUBKEY" -x "$TMP/dl.tar.gz.minisig" >/dev/null 2>&1; then
        echo "      ✓ minisign signature OK"
        STRONG_VERIFIED=1
      else
        fatal_verify "minisign signature verification FAILED"
      fi
    fi
  fi

  # 2. gh build-provenance / SLSA attestation
  if [ "$STRONG_VERIFIED" = 0 ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    echo "      verifying build provenance (gh attestation)..."
    if gh attestation verify "$TMP/dl.tar.gz" --repo "$REPO" >/dev/null 2>&1; then
      echo "      ✓ build provenance verified (SLSA — built by ${REPO} CI)"
      STRONG_VERIFIED=1
    else
      echo "      note: provenance not confirmed (release may predate attestations," >&2
      echo "            or gh is too old) — falling back to SHA-256." >&2
    fi
  fi

  # 3. SHA-256 (always — integrity baseline)
  SHA_VERIFIED=0
  if curl -fsSL --max-time 30 "${URL}.sha256" -o "$TMP/dl.tar.gz.sha256" 2>/dev/null; then
    expected=$(awk '{print $1}' "$TMP/dl.tar.gz.sha256")
    if   command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$TMP/dl.tar.gz" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$TMP/dl.tar.gz" | awk '{print $1}')
    else
      actual=""   # no checksum tool — handled below (never fabricate a match)
    fi
    if [ -z "$actual" ]; then
      if [ "$STRONG_VERIFIED" = 1 ]; then
        echo "      note: no sha256sum/shasum on PATH; relying on the signature/provenance above." >&2
      elif [ "${MOBILE_CC_INSECURE:-0}" = 1 ]; then
        echo "mobile-cc: WARNING — no checksum tool and MOBILE_CC_INSECURE=1; installing unverified." >&2
      else
        fatal_verify "cannot verify download — no minisign/gh and no sha256sum/shasum on PATH (set MOBILE_CC_INSECURE=1 to override)"
      fi
    elif [ "$expected" != "$actual" ]; then
      echo "  expected: $expected" >&2
      echo "  actual:   $actual" >&2
      fatal_verify "SHA-256 checksum mismatch on downloaded binary"
    else
      echo "      ✓ SHA-256 OK"
      SHA_VERIFIED=1
    fi
  fi

  # Fail CLOSED if nothing verified the artifact (no strong verifier AND no
  # checksum could be fetched) — TLS alone is not enough. An explicit
  # MOBILE_CC_INSECURE=1 opts out (e.g. an air-gapped mirror without siblings).
  if [ "$STRONG_VERIFIED" = 0 ] && [ "$SHA_VERIFIED" = 0 ]; then
    if [ "${MOBILE_CC_INSECURE:-0}" = 1 ]; then
      echo "mobile-cc: WARNING — download is UNVERIFIED (no signature, provenance, or" >&2
      echo "  checksum). Proceeding because MOBILE_CC_INSECURE=1 (relying on TLS only)." >&2
    else
      fatal_verify "download is unverified — no signature, no provenance, no .sha256 (set MOBILE_CC_INSECURE=1 to override)"
    fi
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
  STARTED=1
else
  echo "[2/3] systemd skipped; mobile-cc is installed but NOT running yet."
  echo "      start it with:"
  echo "      $PREFIX/mobile-cc --bind $BIND --app-name 'Mobile CC'"
  STARTED=0
fi

# ---------- done ----------
if [ "$STARTED" = "1" ]; then
  # Don't claim "listening" without checking — probe /healthz briefly.
  LIVE=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fs --max-time 1 "http://${BIND}/healthz" >/dev/null 2>&1; then
      LIVE=1
      break
    fi
    sleep 0.5
  done
  if [ "$LIVE" = "1" ]; then
    echo "[3/3] ready"
    echo
    echo "    mobile-cc is listening on http://${BIND}/"
  else
    echo "[3/3] installed, but the service didn't answer on http://${BIND}/ yet."
    echo "      check it with:  systemctl --user status mobile-cc"
    echo "      follow logs:    journalctl --user -u mobile-cc -f"
  fi
else
  echo "[3/3] installed (not started)"
  echo
  echo "    once started, mobile-cc will listen on http://${BIND}/"
fi
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
