# Changelog

All notable changes to mobile-cc are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once mobile-cc
leaves the `0.x` pre-release range.

## [Unreleased]

### Changed

- **New app icon.** The placeholder green-on-black "mcc" text icon is
  replaced with a real mark: a dark terminal card (caret + cursor
  block) on a coral gradient, full-bleed. Distinct at launcher size
  on both light and dark wallpapers, and no longer confusable with a
  generic terminal app. Maskable variants keep the card inside the
  Android safe zone.
- **Header brand redone — no more title row.** The bundled
  `ttyview-app-name` plugin (accent-colored "Mobile CC" text on its
  own top-bar row) is replaced by an internal `mobile-cc-brand`
  plugin: a small logo glyph matching the launcher icon, folded into
  the header row left of the pane picker (via ttyview-core's new
  `header-left` slot). Recovers a full row of vertical space on
  phones. The instance name still reaches the browser/PWA
  task-switcher title and the glyph's tooltip.
- `--app-name` default changed from `Mobile CC` to `mobile-cc` —
  naming is now consistent across the icon, manifest, binary, and
  domain.

## [0.2.1] — 2026-06-12

### Fixed

- **Works on stock Debian 12 / Ubuntu 22.04 tmux (≤ 3.3) — previously
  dead on arrival.** tmux ≤ 3.3 replaces tabs in `-F` format output
  with `_`, which made ttyview-core mint composite pane ids
  (`%0_work_0`) that tmux rejected on `send-keys` — a fresh install
  could not send any input. Fixed in ttyview-core v0.1.3
  (`TTYVIEW_REF` bumped); stale composite ids from old clients are
  normalized server-side, so existing pins keep working after upgrade.
- **CC chat view's "not a Claude Code pane" state** now renders a
  helpful message with a one-tap switch to the terminal view, polls
  at a relaxed 10 s cadence instead of hammering a 404 every 2 s,
  and the pane picker no longer shows blank, nameless rows.
- **install.sh no longer claims "mobile-cc is listening" before
  anything is running.** The systemd path probes `/healthz` before
  declaring ready; the no-systemd path says plainly that mobile-cc
  is installed but not started, and prints the start command. The
  tarball download is also quiet now (no raw curl progress table
  when piped to bash).

### Added

- **Installable as a PWA.** The binary now serves
  `manifest.webmanifest`, a minimal service worker, and the icon set
  from `assets/pwa/` (via ttyview-core's new `RunOptions.extra_static`
  hook); the web client injects the manifest link and registers the
  SW, so Chrome on Android offers "Add to Home screen" and mobile-cc
  opens standalone. No caching, no offline mode — Web Push is the
  next PWA lane. The manifest declares an explicit `id`
  (`mobile-cc-app`) so Chrome doesn't conflate the install with stale
  webapp-registry entries from pre-PWA shortcuts at the same origin.
- **README demo media** — animated GIF + screenshot gallery under
  `.assets/`, captured from `ttyview --demo` (synthetic data) at a
  Pixel-class viewport.

### Fixed (via ttyview-core, needs a fresh upstream tag to release)

- Server-side view/theme sync (`/api/state`) now actually works
  cross-device: a fresh browser no longer resets the server-saved
  active view to `cell-grid`, and the server-chosen view/theme is
  applied (hydration used to store JSON-quoted values that never
  matched a registry id).
- Chat view (`ttyview-cc`): non-CC panes get a friendly "show
  terminal instead" panel instead of a raw `Not a CC pane (404)`
  error; empty filler bubbles ("(empty)", "(no rendered content)")
  are no longer rendered.

## [0.2.0] — 2026-05-20

### Removed

- **`--allow-public-bind` CLI flag and the
  `MOBILE_CC_I_UNDERSTAND_THE_RISKS=1` env-var ack.** The two-factor
  opt-in was designed to make a human reading a tutorial pause, but
  it offered zero friction to LLM agents tasked with "make this
  reachable from my phone" — agents just set both. mobile-cc has no
  built-in auth, so a non-loopback bind hands shell access to anyone
  who reaches the port; the safer ways to expose it (ssh -L,
  Tailscale, cloudflared, reverse proxy with auth) are now the only
  documented paths.

### Changed

- `mobile-cc` now refuses any non-loopback `--bind` value. Error
  message is terse and points at the README's "Reaching mobile-cc from
  elsewhere" section.
- `install.sh` refuses to proceed when `MOBILE_CC_BIND` is non-loopback,
  pointing at the same README section.
- README has a new **Reaching mobile-cc from elsewhere** section
  enumerating the four supported patterns (ssh -L, Tailscale serve,
  cloudflared named tunnel + Access, reverse proxy with auth).
- `SECURITY.md` updated — public-bind is no longer an "operator-opt-in"
  out-of-scope path; the binary doesn't permit it at all.

### Migration

If you were running mobile-cc with `--allow-public-bind` +
`MOBILE_CC_I_UNDERSTAND_THE_RISKS=1`: pick one of the patterns in the
new README section. The most direct replacements:

- **LAN-only public bind → `ssh -L 7800:127.0.0.1:7800 host`** from
  whatever client you want. Same UX, ssh keys handle auth.
- **Tailnet-only public bind → `tailscale serve --bg --https=443
  http://127.0.0.1:7800`.** Tailscale handles TLS + tailnet ACLs.

## [0.1.3] — 2026-05-12

### Added

- Bundles the new `ttyview-session-manager` plugin (settingsTab —
  create / rename / kill tmux sessions from the web UI). Pulls in
  ttyview-core v0.1.2's `/api/sessions/*` HTTP endpoints + WS
  structured input logging.
- Unit tests for the bind-safety guard — all five admission cases plus
  IPv6 loopback and env-var exact-match policy. (`tests/` mod in
  `src/main.rs`.)
- `cargo clippy` + `cargo fmt --check` as a new CI job.
- `cargo audit` + `cargo deny` as a new CI job; `deny.toml` declares the
  permissive license allowlist (MIT, Apache-2.0, BSD variants, Unicode,
  ISC, Zlib, CC0).
- `install.sh` now verifies the downloaded tarball against the
  `.sha256` file Pages publishes alongside it. Refuses to install on
  mismatch. Skipped (with a warning) on hosts lacking both `sha256sum`
  and `shasum`.
- `CHANGELOG.md` (this file); linked from the README.
- `mobile-cc.dev` apex CNAME now resolves directly to the Pages
  project (no more `mobile-cc.pages.dev` fallback hop).

### Changed

- `TTYVIEW_REF` bumped to `v0.1.2` in both `ci.yml` and `release.yml`
  so the build picks up the new session-manager plugin source +
  ttyview's `/api/sessions` route.
- All GitHub Actions references in `.github/workflows/` pinned to
  specific commit SHAs (with the version tag in a trailing comment) for
  supply-chain stability.
- `check_bind_safety()` refactored to take the risk-acknowledgment env
  var value as a parameter — pure, testable, no I/O. The warning +
  countdown lives in a separate `warn_and_countdown_for_public_bind()`
  function called from `main` after the check.

## [0.1.2] — 2026-05-11

### Added

- Re-bundles `ttyview-image-paste` plugin against
  [`ttyview-core` v0.1.1](https://github.com/ttyview/ttyview/releases/tag/v0.1.1)
  — which is the first upstream tag that ships the `/api/uploads` route
  + the image-paste plugin source. Pasting / drag-dropping screenshots
  from the mobile browser uploads + injects them as
  `[image: /path/...]`.

### Changed

- `release.yml` pins `TTYVIEW_REF` to `v0.1.1` for reproducible builds
  (previously tracked `main`).

## [0.1.1] — 2026-05-11

### Added

- **Runtime safety guard against accidental public binds.** mobile-cc
  refuses to bind a non-loopback address unless **both** the
  `--allow-public-bind` CLI flag and the
  `MOBILE_CC_I_UNDERSTAND_THE_RISKS=1` env var are set. With both, a
  3-second countdown banner runs before the daemon binds.
- `install.sh` detects non-loopback `MOBILE_CC_BIND` at install time,
  prints a multi-line warning, and passes both opt-ins through to the
  systemd unit so user-explicit deployments keep working.
- Preflight check in `install.sh` for missing `tmux` — prints the right
  package-manager command per detected distro (`apt-get` / `dnf` /
  `pacman` / `apk` / `brew`). Non-fatal warning.

## [0.1.0] — 2026-05-11

### Added

- Initial binary release.
- Rust binary linking [`ttyview-core`](https://github.com/ttyview/ttyview)
  as a library + a curated 8-plugin bundle (app-name, pane-picker,
  display-toggles, ttyview-cc chat view, quick-keys, pinned-tabs,
  terminal-green theme, plus a mobile-cc-internal defaults plugin).
- First-visit defaults via `mobile-cc-defaults.js` — seeds the chat
  view + Terminal Green theme into client localStorage so a fresh
  phone load lands in the mobile-CC-flavored UI without taps.
- `install.sh` for one-line install on Linux (x86_64 / aarch64) and
  macOS (x86_64 / aarch64). Downloads from the Pages mirror, drops a
  systemd user unit, prints the URL.
- Cross-platform release workflow (`release.yml`) producing 4 target
  tarballs per tag, signed with `.sha256` siblings.
- Pages mirror at
  [`mobile-cc.pages.dev`](https://mobile-cc.pages.dev/) — historical
  context: at v0.1.0 the repo was private, so the GH-released binaries
  needed an anonymous-accessible mirror for `curl | bash` to work.
  The repo became public on 2026-05-14, but the Pages mirror stays
  as the canonical install URL under `mobile-cc.dev`.

### Not yet included

- `ttyview-image-paste` plugin (lands in v0.1.2, gated on upstream
  `ttyview-core` publishing the `/api/uploads` route + plugin source).

[Unreleased]: https://github.com/eyalev/mobile-cc/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/eyalev/mobile-cc/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/eyalev/mobile-cc/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/eyalev/mobile-cc/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/eyalev/mobile-cc/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/eyalev/mobile-cc/releases/tag/v0.1.0
