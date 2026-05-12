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

/// Validate the bind address against mobile-cc's safety policy.
///
/// Pure: takes the risk-acknowledgment env var value as a parameter so tests
/// don't have to manipulate process-wide env vars. Loopback addresses pass
/// unconditionally; non-loopback requires BOTH `allow_public_bind == true`
/// AND `risk_ack == "1"`.
///
/// Returns `Ok(())` if the bind is safe to proceed; `Err` with a verbose
/// explanation otherwise. Does NOT perform the warning + countdown — that
/// lives in `warn_and_countdown_for_public_bind` so the safety check itself
/// stays test-friendly (no I/O, no sleeps).
fn check_bind_safety(
    addr: SocketAddr,
    allow_public_bind: bool,
    risk_ack: &str,
) -> anyhow::Result<()> {
    if addr.ip().is_loopback() {
        return Ok(());
    }
    let ack_ok = risk_ack == "1";
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
    Ok(())
}

/// Print the public-bind warning + 3-second countdown. Only call after
/// `check_bind_safety` returned `Ok(())` for a non-loopback address. Split
/// from the safety check so the latter stays unit-testable without doing
/// I/O or sleeping.
fn warn_and_countdown_for_public_bind(addr: SocketAddr) {
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

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let risk_ack = std::env::var(RISK_ACK_ENV).unwrap_or_default();
    check_bind_safety(cli.bind, cli.allow_public_bind, &risk_ack)?;
    if !cli.bind.ip().is_loopback() {
        warn_and_countdown_for_public_bind(cli.bind);
    }

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

    ttyview_core::cli::daemon::run_with_options_v2(ttyview_core::cli::daemon::RunOptions {
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
        uploads_dir: None,
        allowed_origins: Vec::new(),
    })
    .await
}

#[cfg(test)]
mod tests {
    //! Unit tests for the bind-safety guard. The 5 cases mirror the manual
    //! smoke test from the v0.1.1 ship — keeping them as actual tests means
    //! regressions break CI instead of getting noticed (or missed) on the
    //! next manual run.
    use super::*;

    fn parse(addr: &str) -> SocketAddr {
        addr.parse().expect("valid socket addr")
    }

    /// Case 1: loopback address — passes regardless of the acks.
    #[test]
    fn loopback_bind_passes_with_no_acks() {
        let r = check_bind_safety(parse("127.0.0.1:7800"), false, "");
        assert!(r.is_ok(), "loopback should pass: {r:?}");
    }

    /// Loopback also passes even if the user gratuitously sets both acks.
    #[test]
    fn loopback_bind_passes_with_both_acks() {
        let r = check_bind_safety(parse("127.0.0.1:7800"), true, "1");
        assert!(r.is_ok(), "loopback should pass: {r:?}");
    }

    /// Case 2: non-loopback with neither ack — refused.
    #[test]
    fn public_bind_no_acks_is_refused() {
        let r = check_bind_safety(parse("0.0.0.0:7800"), false, "");
        let msg = r.expect_err("must refuse").to_string();
        assert!(msg.contains("refuses to bind"), "got: {msg}");
        assert!(msg.contains("[✗ missing]"), "got: {msg}");
    }

    /// Case 3: flag-only — still refused (env ack missing).
    #[test]
    fn public_bind_flag_only_is_refused() {
        let r = check_bind_safety(parse("0.0.0.0:7800"), true, "");
        let msg = r.expect_err("must refuse").to_string();
        assert!(
            msg.contains("--allow-public-bind  (CLI flag) [✓ set]"),
            "got: {msg}"
        );
        assert!(msg.contains("(env var) [✗ missing]"), "got: {msg}");
    }

    /// Case 4: env-only — still refused (flag missing).
    #[test]
    fn public_bind_env_only_is_refused() {
        let r = check_bind_safety(parse("0.0.0.0:7800"), false, "1");
        let msg = r.expect_err("must refuse").to_string();
        assert!(
            msg.contains("--allow-public-bind  (CLI flag) [✗ missing]"),
            "got: {msg}"
        );
        assert!(msg.contains("(env var) [✓ set]"), "got: {msg}");
    }

    /// Case 5: both acks — accepted. (Warning + countdown happen separately
    /// in `warn_and_countdown_for_public_bind`, so the safety check itself
    /// returns immediately.)
    #[test]
    fn public_bind_both_acks_passes() {
        let r = check_bind_safety(parse("0.0.0.0:7800"), true, "1");
        assert!(r.is_ok(), "double opt-in should pass: {r:?}");
    }

    /// Specific non-loopback IP (not 0.0.0.0 unspecified) still requires acks.
    #[test]
    fn specific_public_ip_requires_acks() {
        let r = check_bind_safety(parse("1.2.3.4:7800"), false, "");
        assert!(r.is_err(), "specific public IP without acks must refuse");
    }

    /// Random env-var values that aren't exactly "1" are treated as missing.
    /// The exact-match policy prevents `MOBILE_CC_I_UNDERSTAND_THE_RISKS=yes`
    /// or similar handwave from working.
    #[test]
    fn env_ack_must_be_exactly_one() {
        for bogus in ["", "0", "yes", "true", "ok", " 1", "1 "] {
            let r = check_bind_safety(parse("0.0.0.0:7800"), true, bogus);
            assert!(r.is_err(), "ack={bogus:?} must be refused");
        }
    }

    /// IPv6 loopback ::1 also passes — `is_loopback()` covers both families.
    #[test]
    fn ipv6_loopback_passes() {
        let r = check_bind_safety(parse("[::1]:7800"), false, "");
        assert!(r.is_ok(), "ipv6 loopback should pass: {r:?}");
    }
}
