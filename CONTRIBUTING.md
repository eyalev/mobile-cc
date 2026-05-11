# Contributing to mobile-cc

> ⚠️ **External contributions are paused while the platform stabilizes.**
> mobile-cc is pre-alpha; the CLI surface, plugin set, and `ttyview-core`
> library API it depends on are all still moving. If you want to hack on it
> for yourself, instructions below — but please don't open PRs against
> upstream yet. The maintainer will signal "open for contributions" in the
> README when the shape is settled. Until then, fork freely.

mobile-cc is a thin Rust binary that links
[`ttyview-core`](https://github.com/ttyview/ttyview) as a library and ships
a curated plugin set + defaults tuned for driving Claude Code from a phone.
Most of the interesting code lives upstream in ttyview — this repo is
~150 lines of `main.rs`, a handful of bundled JS plugins, and a release
pipeline.

## Build from source

mobile-cc consumes `ttyview-core` via a Cargo **path dependency** at
`../ttyview/crates/ttyview-core`. The directory layout has to match:

```
projects/
├── mobile-cc/        ← this repo
└── ttyview/          ← cloned alongside, on the right ref
```

Then:

```bash
git clone https://github.com/eyalev/mobile-cc
git clone https://github.com/ttyview/ttyview \
  --branch v0.1.1   # whatever release.yml's TTYVIEW_REF is pinned to
cd mobile-cc
cargo build --release
./target/release/mobile-cc --help
```

Once `ttyview-core` is published to crates.io, the path-dep becomes a
version-pinned dep and the sibling-checkout dance goes away.

## Repository layout

| Path | What |
|---|---|
| `src/main.rs` | The binary — clap CLI, config-dir resolution, runtime safety guard, hand-off to `ttyview_core::cli::daemon::run_with_options_v2`. |
| `assets/installed.json` | Manifest of bundled plugins. Written to `<config_dir>/plugins/installed.json` on first run. |
| `assets/mobile-cc-defaults.js` | Internal plugin that seeds `active_view` + `active_theme` in localStorage on first visit. mobile-cc-specific; not in upstream. |
| `install.sh` | The public installer. Detects platform, downloads from Pages mirror, drops a systemd user unit. |
| `.github/workflows/{ci,release}.yml` | CI build + tag-driven cross-build of 4 release targets. |
| `Dockerfile.binaries` *(future)* | If/when we publish reproducible bookworm-compatible Linux binaries. |

## Where the plugin surface lives

mobile-cc bundles plugins from
`../ttyview/crates/ttyview-core/community-plugins/*.js` via `include_bytes!`
in `src/main.rs`. **The plugin contract — the `window.ttyview` API, the six
contribution kinds, the events — is defined upstream**, see
[`ttyview/CONTRIBUTING.md`](https://github.com/ttyview/ttyview/blob/main/CONTRIBUTING.md).

To add or change a plugin, prefer landing it upstream first, then bumping
mobile-cc's pin of `ttyview-core` and refreshing the `include_bytes!` list.
mobile-cc-internal plugins (like `mobile-cc-defaults.js`) live in
`assets/` here.

## Tests

mobile-cc has no test suite of its own yet — the platform invariants are
covered upstream by ttyview's vitest + Playwright suites. The CI workflow
here only verifies that the binary builds and `--help` runs without
panicking.

When mobile-cc grows code beyond plumbing (subcommands, named-tunnel
integration, etc.), tests should land alongside.

## Release process

For maintainer reference — tag-driven, see `.github/workflows/release.yml`:

1. Bump version in `Cargo.toml` + `Cargo.lock` (`cargo build --release` will
   refresh the lock).
2. Commit + push to `main`.
3. `git tag -a vX.Y.Z -m '...'  &&  git push origin vX.Y.Z`.
4. CI cross-builds 4 targets and publishes a GitHub Release.
5. Mirror the release tarballs onto Cloudflare Pages so anonymous installs
   work (`gh release download` → `wrangler pages deploy`).

The `latest.txt` on the Pages site is the source of truth `install.sh`
consults; bump it last so partial deploys don't break in-flight installs.

## License

MIT. By contributing you agree your contribution is licensed the same way.

## Maintainer

Single-author project — eyalev@gmail.com. Response times during the
pre-alpha window are best-effort; see [`SECURITY.md`](./SECURITY.md) for
the explicit unavailability window.
