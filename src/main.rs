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
    /// Address to bind the HTTP/WS server on.
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

    /// Required when --bind specifies a non-loopback address. mobile-cc has
    /// no built-in authentication; binding publicly without a fronting
    /// reverse proxy hands shell access to anyone who finds the port. Setting
    /// this flag is necessary but not sufficient — the environment variable
    /// MOBILE_CC_I_UNDERSTAND_THE_RISKS=1 must also be set.
    #[arg(long)]
    allow_public_bind: bool,
}

/// Environment variable required (in addition to --allow-public-bind) to bind
/// a non-loopback address. Two-factor opt-in: a tutorial-copy-paster has to
/// notice both, not just one.
const RISK_ACK_ENV: &str = "MOBILE_CC_I_UNDERSTAND_THE_RISKS";

fn check_bind_safety(addr: SocketAddr, allow_public_bind: bool) -> anyhow::Result<()> {
    if addr.ip().is_loopback() {
        return Ok(());
    }
    let ack = std::env::var(RISK_ACK_ENV).unwrap_or_default();
    let ack_ok = ack == "1";
    if !allow_public_bind || !ack_ok {
        anyhow::bail!(
            "\nmobile-cc refuses to bind a non-loopback address ({}) without explicit acknowledgment.\n\
             \n\
             Anyone who can reach this port will be able to drive your tmux session.\n\
             mobile-cc has NO built-in authentication. If you intend to expose mobile-cc\n\
             publicly, you must put a reverse proxy with auth in front (Caddy, oauth2-proxy,\n\
             etc.) OR ensure the network is private (Tailscale tailnet, LAN-only).\n\
             \n\
             To proceed, supply BOTH of the following:\n  --allow-public-bind  (CLI flag) {}\n  {}=1     (env var) {}\n\
             \n\
             Recommended setup instead: bind 127.0.0.1 (the default) and reach mobile-cc\n\
             from your phone via Tailscale, `ssh -L`, or `cloudflared`.",
            addr.ip(),
            if allow_public_bind { "[✓ set]" } else { "[✗ missing]" },
            RISK_ACK_ENV,
            if ack_ok { "[✓ set]" } else { "[✗ missing]" },
        );
    }
    // Both acks present — warn loudly, brief countdown, then proceed.
    eprintln!();
    eprintln!("  ⚠ mobile-cc bound to {addr} — exposed beyond loopback.");
    eprintln!("  ⚠ Anyone reaching this port can drive your shell. No built-in auth.");
    eprintln!("  ⚠ Ensure a fronting reverse proxy with auth, or a private network.");
    eprintln!();
    for n in (1..=3).rev() {
        eprint!("    starting in {n}... \r");
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    eprintln!("                        ");
    Ok(())
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
const PLUGIN_SOURCES: &[(&str, &[u8])] = &[
    ("mobile-cc-defaults.js",      include_bytes!("../assets/mobile-cc-defaults.js")),
    ("ttyview-app-name.js",        include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-app-name.js")),
    ("ttyview-pane-picker.js",     include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-pane-picker.js")),
    ("ttyview-display-toggles.js", include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-display-toggles.js")),
    ("ttyview-cc.js",              include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-cc.js")),
    ("ttyview-quickkeys.js",       include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-quickkeys.js")),
    ("ttyview-tabs.js",            include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-tabs.js")),
    // ttyview-image-paste lands in v0.2.0 once ttyview-core publishes
    // the /api/uploads route + the plugin source (currently both WIP
    // upstream, not on public ttyview/main).
    ("ttyview-terminal-green.js",  include_bytes!("../../ttyview/crates/ttyview-core/community-plugins/ttyview-terminal-green.js")),
];

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    check_bind_safety(cli.bind, cli.allow_public_bind)?;

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
        format!("writing bundled plugin manifest to {}", installed_json.display())
    })?;

    eprintln!();
    eprintln!("    mobile-cc {} listening on http://{}/", env!("CARGO_PKG_VERSION"), cli.bind);
    eprintln!("    config dir: {}", config_dir.display());
    eprintln!();

    ttyview_core::cli::daemon::run_with_options_v2(
        ttyview_core::cli::daemon::RunOptions {
            addr: cli.bind,
            socket: cli.tmux_socket,
            rows: 50,
            cols: 80,
            tls_cert: None,
            tls_key: None,
            diag_log: None,
            registry_url: None,
            demo_mode: false,
            read_only: false,
            config_dir: Some(config_dir),
            app_name: Some(cli.app_name),
        },
    )
    .await
}
