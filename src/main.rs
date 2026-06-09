use anyhow::{Context, Result};
use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;

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

    /// Display name shown in the header (via the App Name plugin). Useful when
    /// several mobile-cc instances run on different hosts.
    #[arg(long, default_value = "Mobile CC")]
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
    ("ttyview-app-name.js",        include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-app-name.js")),
    ("ttyview-pane-picker.js",     include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-pane-picker.js")),
    ("ttyview-display-toggles.js", include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-display-toggles.js")),
    ("ttyview-cc.js",              include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-cc.js")),
    ("ttyview-quickkeys.js",       include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-quickkeys.js")),
    ("ttyview-tabs.js",            include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-tabs.js")),
    ("ttyview-image-paste.js",     include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-image-paste.js")),
    ("ttyview-session-manager.js", include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-session-manager.js")),
    ("ttyview-terminal-green.js",  include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-terminal-green.js")),
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
    ttyview_core::cli::daemon::run_with_options_v2(ttyview_core::cli::daemon::RunOptions {
        addr: cli.bind,
        socket: cli.tmux_socket,
        config_dir: Some(config_dir),
        app_name: Some(cli.app_name),
        extra_static: PWA_ASSETS
            .iter()
            .map(|(path, bytes)| (path.to_string(), bytes.to_vec()))
            .collect(),
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
