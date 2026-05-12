# Changelog

All notable changes to mobile-cc are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once mobile-cc
leaves the `0.x` pre-release range.

## [Unreleased]

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
  [`mobile-cc.pages.dev`](https://mobile-cc.pages.dev/) for anonymous
  install — the GH releases are auth-gated while the repo is private,
  so binaries are mirrored to Pages for `curl | bash` to work.

### Not yet included

- `ttyview-image-paste` plugin (lands in v0.1.2, gated on upstream
  `ttyview-core` publishing the `/api/uploads` route + plugin source).

[Unreleased]: https://github.com/eyalev/mobile-cc/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/eyalev/mobile-cc/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/eyalev/mobile-cc/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/eyalev/mobile-cc/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/eyalev/mobile-cc/releases/tag/v0.1.0
