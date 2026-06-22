use anyhow::{Context, Result};
use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;

mod cc_search;
mod download;

/// Drive Claude Code from your phone. A focused, mobile-first packaging of
/// ttyview-core — bundles the right plugin set, names the right defaults, and
/// hides the platform's general-purpose flags.
#[derive(Parser, Debug)]
#[command(name = "mobile-cc", version, about, long_about = None)]
struct Cli {
    /// Address to bind the HTTP/WS server on. mobile-cc accepts loopback
    /// addresses only — see the README's "Reaching mobile-cc from elsewhere"
    /// section for safe ways to expose it.
    #[arg(long, default_value = "127.0.0.1:7800")]
    bind: SocketAddr,

    /// Instance name — shown in the browser/PWA task-switcher title and the
    /// header logo's tooltip (via the mobile-cc-brand plugin). Useful when
    /// several mobile-cc instances run on different hosts.
    #[arg(long, default_value = "mobile-cc")]
    app_name: String,

    /// Tmux socket name (passed to `tmux -L`). Omit for the default server.
    #[arg(long, value_name = "NAME")]
    tmux_socket: Option<String>,

    /// Override the config dir (default: $XDG_CONFIG_HOME/mobile-cc).
    /// Holds the bundled plugin manifest + any uploads-staging metadata.
    #[arg(long, value_name = "DIR")]
    config_dir: Option<PathBuf>,
}

/// Validate the bind address against mobile-cc's loopback-only policy.
///
/// mobile-cc has no built-in authentication; anyone who can reach the port
/// can drive the tmux session. The binary therefore refuses to bind any
/// non-loopback address. Users who need cross-device access route through a
/// fronting layer that provides auth (Tailscale, ssh -L, cloudflared, a
/// reverse proxy with basic-auth / oauth2-proxy).
///
/// Pure: no I/O, no env reads — kept that way so the test suite stays small
/// and there's no implicit bypass to maintain.
fn check_bind_safety(addr: SocketAddr) -> anyhow::Result<()> {
    if addr.ip().is_loopback() {
        return Ok(());
    }
    anyhow::bail!(
        "mobile-cc only binds 127.0.0.1.\n\
         To reach it from another device, see:\n  \
         https://github.com/eyalev/mobile-cc#reaching-mobile-cc-from-elsewhere"
    );
}

/// The plugin set baked into the binary. Written to
/// `<config_dir>/plugins/installed.json` on first run — the ttyview-core
/// daemon reads it from there to know which bundled plugins to surface.
const BUNDLED_INSTALLED_JSON: &str = include_str!("../assets/installed.json");

/// Plugin source files baked into the binary. ttyview-core's
/// `GET /plugins/installed/:id/source` reads from
/// `<config_dir>/plugins/<source_filename>`, so we copy each file there on
/// first run. This decouples mobile-cc's plugin set from upstream's
/// `community-plugins/` bundle — when upstream changes, we recompile to pick
/// it up, on our own cadence.
#[rustfmt::skip] // preserve the column-aligned table for readability
const PLUGIN_SOURCES: &[(&str, &[u8])] = &[
    ("mobile-cc-defaults.js",      include_bytes!("../assets/mobile-cc-defaults.js")),
    ("mobile-cc-autofit.js",       include_bytes!("../assets/mobile-cc-autofit.js")),
    ("mobile-cc-brand.js",         include_bytes!("../assets/mobile-cc-brand.js")),
    ("mobile-cc-commands.js",      include_bytes!("../assets/mobile-cc-commands.js")),
    ("mobile-cc-quickkeys.js",     include_bytes!("../assets/mobile-cc-quickkeys.js")),
    ("mobile-cc-new-tab.js",       include_bytes!("../assets/mobile-cc-new-tab.js")),
    ("mobile-cc-tab-menu.js",      include_bytes!("../assets/mobile-cc-tab-menu.js")),
    ("mobile-cc-kbd-overlay.js",   include_bytes!("../assets/mobile-cc-kbd-overlay.js")),
    ("mobile-cc-term-size.js",     include_bytes!("../assets/mobile-cc-term-size.js")),
    ("mobile-cc-pinch-zoom.js",    include_bytes!("../assets/mobile-cc-pinch-zoom.js")),
    ("mobile-cc-scrollback.js",    include_bytes!("../assets/mobile-cc-scrollback.js")),
    ("mobile-cc-cc-search.js",     include_bytes!("../assets/mobile-cc-cc-search.js")),
    ("mobile-cc-tabs.js",          include_bytes!("../assets/mobile-cc-tabs.js")),
    ("mobile-cc-native-screenshot.js", include_bytes!("../assets/mobile-cc-native-screenshot.js")),
    ("mobile-cc-download.js",      include_bytes!("../assets/mobile-cc-download.js")),
    // TEMP diagnostic — soft-keyboard-on-tab-switch tracer. Remove with
    // its assets/installed.json entry once the cause is pinned.
    ("mobile-cc-kbd-diag.js",      include_bytes!("../assets/mobile-cc-kbd-diag.js")),
    ("ttyview-pane-picker.js",     include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-pane-picker.js")),
    ("ttyview-display-toggles.js", include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-display-toggles.js")),
    ("ttyview-cc.js",              include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-cc.js")),
    ("ttyview-tabs.js",            include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-tabs.js")),
    ("ttyview-image-paste.js",     include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-image-paste.js")),
    ("ttyview-stt-groq.js",        include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-stt-groq.js")),
    ("ttyview-reload.js",          include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-reload.js")),
    ("ttyview-logs.js",            include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-logs.js")),
    ("ttyview-session-manager.js", include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-session-manager.js")),
    ("ttyview-terminal-green.js",  include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-terminal-green.js")),
    ("ttyview-live-sync.js",       include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-live-sync.js")),
];

/// PWA assets baked into the binary and served by ttyview-core at
/// absolute URL paths (via `RunOptions::extra_static`). The daemon
/// advertises the manifest + service worker on `GET /api/instance`;
/// the web client injects the manifest link and registers the SW,
/// making mobile-cc installable from Chrome's prompt on Android.
/// Design notes + future Web Push scope: `assets/pwa/README.md`.
#[rustfmt::skip] // preserve the column-aligned table for readability
const PWA_ASSETS: &[(&str, &[u8])] = &[
    ("/manifest.webmanifest",          include_bytes!("../assets/pwa/manifest.webmanifest")),
    ("/sw.js",                         include_bytes!("../assets/pwa/sw.js")),
    ("/pwa/icons/icon-192.png",          include_bytes!("../assets/pwa/icons/icon-192.png")),
    ("/pwa/icons/icon-512.png",          include_bytes!("../assets/pwa/icons/icon-512.png")),
    ("/pwa/icons/icon-192-maskable.png", include_bytes!("../assets/pwa/icons/icon-192-maskable.png")),
    ("/pwa/icons/icon-512-maskable.png", include_bytes!("../assets/pwa/icons/icon-512-maskable.png")),
];

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    check_bind_safety(cli.bind)?;

    let config_dir = cli.config_dir.unwrap_or_else(|| {
        dirs::config_dir()
            .map(|d| d.join("mobile-cc"))
            .unwrap_or_else(|| PathBuf::from(".mobile-cc"))
    });

    let plugins_dir = config_dir.join("plugins");
    std::fs::create_dir_all(&plugins_dir)
        .with_context(|| format!("creating {}", plugins_dir.display()))?;

    // Seed each bundled plugin source file. We rewrite on every startup if the
    // file is missing OR shorter than what we ship — covers the case where the
    // user upgrades mobile-cc and a plugin's source has grown.
    for (filename, bytes) in PLUGIN_SOURCES {
        let dest = plugins_dir.join(filename);
        let needs_write = match std::fs::metadata(&dest) {
            Ok(meta) => meta.len() as usize != bytes.len(),
            Err(_) => true,
        };
        if needs_write {
            std::fs::write(&dest, bytes)
                .with_context(|| format!("writing bundled plugin {}", dest.display()))?;
        }
    }

    // Seed installed.json. We overwrite this on every startup so the enabled
    // set always reflects the mobile-cc binary we're running, not stale state.
    let installed_json = plugins_dir.join("installed.json");
    std::fs::write(&installed_json, BUNDLED_INSTALLED_JSON).with_context(|| {
        format!(
            "writing bundled plugin manifest to {}",
            installed_json.display()
        )
    })?;

    eprintln!();
    eprintln!(
        "    mobile-cc {} listening on http://{}/",
        env!("CARGO_PKG_VERSION"),
        cli.bind
    );
    eprintln!("    config dir: {}", config_dir.display());
    eprintln!();

    // `..Default::default()` so future ttyview-core RunOptions fields
    // don't force an update here (the upstream struct doc asks for this
    // construction form ahead of an eventual #[non_exhaustive]).
    // Always-on diagnostics: client ttvDiag events (WS lifecycle, sub
    // acks, input failures, stalls) flow over the WS and land here as
    // JSONL. Phones have no devtools — this file is the only record of
    // what the client saw when something gets stuck. Analyze with
    // ttyview's scripts/ttyview-diag.
    let diag_log = config_dir.join("diag.jsonl");

    // Keep mobile-cc's image uploads under its own cache dir
    // (`~/.cache/mobile-cc/uploads`) instead of ttyview-core's shared
    // default (`~/.cache/ttyview/uploads`) — mobile-cc is its own app,
    // its uploads shouldn't comingle with a bare ttyview install's.
    let uploads_dir = dirs::cache_dir()
        .map(|d| d.join("mobile-cc/uploads"))
        .unwrap_or_else(|| PathBuf::from(".mobile-cc/uploads"));

    // cc-search reads Claude Code transcripts from `~/.claude/projects`
    // (honoring CLAUDE_CONFIG_DIR like CC itself). The endpoint maps
    // sessions to open tabs via the same tmux socket the daemon drives.
    let cc_projects_root = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".claude")))
        .unwrap_or_else(|| PathBuf::from(".claude"))
        .join("projects");
    let cc_search_cfg = cc_search::CcSearchConfig {
        projects_root: cc_projects_root,
        tmux_socket: cli.tmux_socket.clone(),
    };

    // /api/download — serve a host file for one-tap downloads from the
    // terminal. Allowlisted to $HOME: whoever can reach the UI already has a
    // shell in the pane, so this exposes no new capability. See src/download.rs.
    let download_cfg = download::DownloadConfig {
        roots: dirs::home_dir().into_iter().collect(),
        home: dirs::home_dir(),
    };
    // `extra_api` is a single hook — compose cc-search + download into one
    // closure that mounts both route sets.
    let cc_api = cc_search::extra_api(cc_search_cfg);
    let dl_api = download::extra_api(download_cfg);
    let extra_api: Box<dyn FnOnce(axum::Router) -> axum::Router + Send> =
        Box::new(move |router| dl_api(cc_api(router)));

    ttyview_core::cli::daemon::run_with_options_v2(ttyview_core::cli::daemon::RunOptions {
        addr: cli.bind,
        socket: cli.tmux_socket,
        config_dir: Some(config_dir),
        app_name: Some(cli.app_name),
        diag_log: Some(diag_log),
        uploads_dir: Some(uploads_dir),
        extra_static: PWA_ASSETS
            .iter()
            .map(|(path, bytes)| (path.to_string(), bytes.to_vec()))
            .collect(),
        // Single-user box: keep a deep per-pane scrollback so the phone
        // can scroll far back. The default (2000) is tuned for
        // multi-session embedders; mobile-cc has a handful of panes, so
        // 10_000 lines is cheap and gives the Settings → Scrollback
        // control real headroom. See assets/mobile-cc-scrollback.js.
        max_scrollback: Some(10_000),
        // CC-transcript search (/api/cc-search, /api/cc-session/:id) +
        // file download (/api/download). See src/cc_search.rs, src/download.rs.
        extra_api: Some(extra_api),
        ..Default::default()
    })
    .await
}

#[cfg(test)]
mod tests {
    //! Unit tests for the bind-safety guard. v0.2.0 removed the
    //! `--allow-public-bind` bypass — the policy is now simply
    //! loopback-only, no opt-in flag.
    use super::*;

    fn parse(addr: &str) -> SocketAddr {
        addr.parse().expect("valid socket addr")
    }

    #[test]
    fn ipv4_loopback_passes() {
        assert!(check_bind_safety(parse("127.0.0.1:7800")).is_ok());
    }

    #[test]
    fn ipv6_loopback_passes() {
        assert!(check_bind_safety(parse("[::1]:7800")).is_ok());
    }

    #[test]
    fn unspecified_v4_is_refused() {
        let err = check_bind_safety(parse("0.0.0.0:7800")).expect_err("must refuse");
        let msg = err.to_string();
        assert!(msg.contains("only binds 127.0.0.1"), "got: {msg}");
        assert!(
            msg.contains("reaching-mobile-cc-from-elsewhere"),
            "got: {msg}"
        );
    }

    #[test]
    fn specific_public_ip_is_refused() {
        assert!(check_bind_safety(parse("1.2.3.4:7800")).is_err());
        assert!(check_bind_safety(parse("10.0.0.5:7800")).is_err());
        assert!(check_bind_safety(parse("192.168.1.10:7800")).is_err());
    }

    #[test]
    fn unspecified_v6_is_refused() {
        assert!(check_bind_safety(parse("[::]:7800")).is_err());
    }
}

#[cfg(test)]
mod bundle_tests {
    //! The bundled plugin set lives in TWO places that must agree:
    //! `PLUGIN_SOURCES` (the embedded JS, written to disk on first run) and
    //! `assets/installed.json` (the manifest ttyview reads to surface
    //! plugins). Adding a plugin to only one is an easy footgun — a manifest
    //! entry with no source 404s; a source with no manifest entry is dead
    //! weight that never registers. These tests keep the two in lock-step.
    use super::*;
    use std::collections::HashSet;

    /// Pull every `"source":"<file>"` value out of the manifest JSON without
    /// taking a serde_json dependency (the manifest is a fixed, simple shape).
    fn manifest_sources() -> Vec<String> {
        let needle = "\"source\":\"";
        let mut out = Vec::new();
        let mut rest = BUNDLED_INSTALLED_JSON;
        while let Some(i) = rest.find(needle) {
            rest = &rest[i + needle.len()..];
            if let Some(end) = rest.find('"') {
                out.push(rest[..end].to_string());
                rest = &rest[end..];
            }
        }
        out
    }

    #[test]
    fn every_manifest_source_is_bundled() {
        let bundled: HashSet<&str> = PLUGIN_SOURCES.iter().map(|(n, _)| *n).collect();
        for src in manifest_sources() {
            assert!(
                bundled.contains(src.as_str()),
                "installed.json lists `{src}` but it is not in PLUGIN_SOURCES — \
                 ttyview would serve 404 for that plugin"
            );
        }
    }

    #[test]
    fn every_bundled_plugin_is_in_manifest_and_nonempty() {
        let sources = manifest_sources();
        for (name, bytes) in PLUGIN_SOURCES {
            assert!(
                sources.iter().any(|s| s == name),
                "`{name}` is in PLUGIN_SOURCES but missing from installed.json — \
                 it would be written to disk but never registered"
            );
            assert!(!bytes.is_empty(), "bundled plugin `{name}` is empty");
        }
    }

    #[test]
    fn manifest_and_sources_are_one_to_one() {
        assert_eq!(
            manifest_sources().len(),
            PLUGIN_SOURCES.len(),
            "installed.json entry count != PLUGIN_SOURCES count — a plugin was \
             added or removed in only one of the two places"
        );
    }
}
