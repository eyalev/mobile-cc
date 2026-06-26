//! push — Web Push (VAPID) so the phone buzzes when CC needs you.
//!
//! Two trigger sources, both server-side semantic events delivered through
//! ttyview-core's `RunOptions.on_semantic` hook:
//!   * `claude.permission_prompt`     → always notifies (the headline use)
//!   * `pane.idle_after_activity`     → only if idle alerts are enabled
//!
//! Pipeline: the `on_semantic` callback is cheap — it maps the event to a
//! `PushJob` and `try_send`s it onto an mpsc channel. A background worker
//! drains the channel, applies per-pane coalescing (1/min), resolves the
//! pane's tmux session name (payload is SESSION NAME ONLY — privacy: it
//! shows on a lock screen), VAPID-signs + encrypts, and sends to every
//! stored subscription, pruning any the push service reports gone (404/410).
//!
//! Routes (mounted via the `extra_api` hook, composed with cc-search/download):
//!   GET  /api/push/vapid-key   → { publicKey }   (applicationServerKey)
//!   POST /api/push/subscribe   ← PushSubscription
//!   POST /api/push/unsubscribe ← { endpoint }
//!   GET  /api/push/status      → { count, vapidPublicKey, idleEnabled }
//!   POST /api/push/settings    ← { idleEnabled }
//!   POST /api/push/test        → fire a test notification to all subs
//!
//! Keys + state live under `~/.config/mobile-cc/push/` (chmod 600):
//!   vapid_private.pem · vapid_public.txt · subscriptions.json · settings.json
//!
//! Design + open questions: `.claude/web-push-design.md`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::Extension,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::{mpsc, Mutex};

use ttyview_core::detectors::{SemanticEvent, SemanticHook};

use base64::Engine;
use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

const VAPID_SUBJECT: &str = "mailto:eyalev@gmail.com";
const COALESCE_WINDOW: Duration = Duration::from_secs(60);

// ---- on-disk shapes ---------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubKeys,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub ua_label: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SubKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct Settings {
    /// Idle-after-activity notifications. Off by default (noisier than
    /// permission prompts).
    idle_enabled: bool,
}

// ---- shared state -----------------------------------------------------

pub struct PushState {
    push_dir: PathBuf,
    tmux_socket: Option<String>,
    vapid_public_b64: String,
    vapid_pem: Vec<u8>,
    subs: Mutex<Vec<Subscription>>,
    settings: Mutex<Settings>,
    jobs: mpsc::Sender<PushJob>,
}

struct PushJob {
    pane: String,
    kind: JobKind,
}

#[derive(PartialEq)]
enum JobKind {
    Permission,
    Idle,
}

/// Initialize push: generate the VAPID keypair on first run, load
/// subscriptions + settings, and spawn the delivery worker. Call once at
/// startup, inside the tokio runtime.
pub fn init(config_dir: PathBuf, tmux_socket: Option<String>) -> anyhow::Result<Arc<PushState>> {
    let push_dir = config_dir.join("push");
    std::fs::create_dir_all(&push_dir)?;
    restrict_dir(&push_dir);

    let (vapid_pem, vapid_public_b64) = ensure_vapid(&push_dir)?;
    let subs = load_json(&push_dir.join("subscriptions.json")).unwrap_or_default();
    let settings: Settings = load_json(&push_dir.join("settings.json")).unwrap_or_default();

    let (tx, rx) = mpsc::channel::<PushJob>(256);
    let state = Arc::new(PushState {
        push_dir,
        tmux_socket,
        vapid_public_b64,
        vapid_pem,
        subs: Mutex::new(subs),
        settings: Mutex::new(settings),
        jobs: tx,
    });
    spawn_worker(state.clone(), rx);
    Ok(state)
}

/// The `on_semantic` hook handed to ttyview-core's `RunOptions`. Cheap:
/// classify + enqueue, never blocks the state loop.
pub fn on_semantic_hook(state: Arc<PushState>) -> SemanticHook {
    Arc::new(move |pane: &str, ev: &SemanticEvent| {
        let kind = match ev.name.as_str() {
            "claude.permission_prompt" => JobKind::Permission,
            "pane.idle_after_activity" => JobKind::Idle,
            _ => return,
        };
        // try_send: if the worker is backed up we drop rather than block the
        // hot path. A missed buzz is better than stalling the pane loop.
        let _ = state.jobs.try_send(PushJob {
            pane: pane.to_string(),
            kind,
        });
    })
}

/// Routes merged into the daemon router via the `extra_api` hook.
pub fn routes(state: Arc<PushState>) -> Router {
    Router::new()
        .route("/api/push/vapid-key", get(vapid_key))
        .route("/api/push/subscribe", post(subscribe))
        .route("/api/push/unsubscribe", post(unsubscribe))
        .route("/api/push/status", get(status))
        .route("/api/push/settings", post(set_settings))
        .route("/api/push/test", post(test_push))
        .layer(Extension(state))
        // Same-origin guard (mirrors ttyview-core's WS origin check) — blocks a
        // cross-origin page the user visits from driving these endpoints. See
        // src/origin.rs. Origin-less (non-browser) callers pass, as on the WS
        // path; the SSRF guard in `subscribe`/`deliver` is the caller-
        // independent protection.
        .layer(axum::middleware::from_fn(crate::origin::origin_guard))
}

// ---- route handlers ---------------------------------------------------

async fn vapid_key(Extension(s): Extension<Arc<PushState>>) -> impl IntoResponse {
    Json(serde_json::json!({ "publicKey": s.vapid_public_b64 }))
}

async fn subscribe(
    Extension(s): Extension<Arc<PushState>>,
    Json(sub): Json<Subscription>,
) -> impl IntoResponse {
    // SSRF guard: the endpoint is a URL the daemon POSTs to from the server,
    // so reject any non-public target before it can be stored or dispatched.
    if !crate::origin::is_safe_push_endpoint(&sub.endpoint) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "invalid endpoint" })),
        )
            .into_response();
    }
    {
        let mut subs = s.subs.lock().await;
        // Dedupe by endpoint.
        if !subs.iter().any(|x| x.endpoint == sub.endpoint) {
            subs.push(sub);
        }
        persist_subs(&s, &subs);
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct EndpointReq {
    endpoint: String,
}

async fn unsubscribe(
    Extension(s): Extension<Arc<PushState>>,
    Json(req): Json<EndpointReq>,
) -> impl IntoResponse {
    {
        let mut subs = s.subs.lock().await;
        subs.retain(|x| x.endpoint != req.endpoint);
        persist_subs(&s, &subs);
    }
    Json(serde_json::json!({ "ok": true }))
}

async fn status(Extension(s): Extension<Arc<PushState>>) -> impl IntoResponse {
    // L4: deliberately NOT exposing the subscription count — a caller learns
    // only whether idle alerts are on + the (public) VAPID key. The client
    // derives "subscribed on this device" from the SW, not from a count.
    let idle = s.settings.lock().await.idle_enabled;
    Json(serde_json::json!({
        "vapidPublicKey": s.vapid_public_b64,
        "idleEnabled": idle,
    }))
}

#[derive(Deserialize)]
struct SettingsReq {
    idle_enabled: bool,
}

async fn set_settings(
    Extension(s): Extension<Arc<PushState>>,
    Json(req): Json<SettingsReq>,
) -> impl IntoResponse {
    {
        let mut st = s.settings.lock().await;
        st.idle_enabled = req.idle_enabled;
        write_json(&s.push_dir.join("settings.json"), &*st);
    }
    Json(serde_json::json!({ "ok": true }))
}

async fn test_push(Extension(s): Extension<Arc<PushState>>) -> impl IntoResponse {
    let n = deliver(
        &s,
        "mobile-cc",
        "Test notification — push is working.",
        "test",
    )
    .await;
    (StatusCode::OK, Json(serde_json::json!({ "sent": n })))
}

// ---- delivery worker --------------------------------------------------

fn spawn_worker(state: Arc<PushState>, mut rx: mpsc::Receiver<PushJob>) {
    tokio::spawn(async move {
        // Per-pane coalescing: collapse bursts to one notification / minute.
        let mut last_sent: HashMap<String, Instant> = HashMap::new();
        while let Some(job) = rx.recv().await {
            if job.kind == JobKind::Idle && !state.settings.lock().await.idle_enabled {
                continue;
            }
            let now = Instant::now();
            if let Some(prev) = last_sent.get(&job.pane) {
                if now.duration_since(*prev) < COALESCE_WINDOW {
                    continue;
                }
            }
            last_sent.insert(job.pane.clone(), now);

            let session = resolve_session(state.tmux_socket.as_deref(), &job.pane)
                .unwrap_or_else(|| job.pane.clone());
            let (title, body, kind) = match job.kind {
                JobKind::Permission => (
                    "Claude needs permission".to_string(),
                    session.clone(),
                    "permission",
                ),
                JobKind::Idle => ("Claude is waiting".to_string(), session.clone(), "idle"),
            };
            let _ = deliver(&state, &title, &body, kind).await;
        }
    });
}

/// Build + send the notification to every subscription. Returns how many
/// were delivered; prunes subscriptions the push service says are gone.
async fn deliver(state: &Arc<PushState>, title: &str, body: &str, kind: &str) -> usize {
    let subs = state.subs.lock().await.clone();
    if subs.is_empty() {
        return 0;
    }
    // HyperWebPushClient::new() is infallible (pure-Rust hyper backend; no
    // libcurl init that could fail) — unlike IsahcWebPushClient. The static
    // release build uses hyper-client to avoid the libcurl C dep.
    let client = HyperWebPushClient::new();
    let payload = serde_json::json!({
        "title": title,
        "body": body,
        "type": kind,
    })
    .to_string();

    let mut sent = 0usize;
    let mut dead: Vec<String> = Vec::new();
    for sub in &subs {
        // Belt-and-suspenders: `subscribe` already rejects non-public
        // endpoints, but never POST to one even if an older/hand-edited
        // subscriptions.json slipped one in.
        if !crate::origin::is_safe_push_endpoint(&sub.endpoint) {
            continue;
        }
        let info = SubscriptionInfo::new(
            sub.endpoint.clone(),
            sub.keys.p256dh.clone(),
            sub.keys.auth.clone(),
        );
        let sig = match VapidSignatureBuilder::from_pem(state.vapid_pem.as_slice(), &info).and_then(
            |mut b| {
                b.add_claim("sub", VAPID_SUBJECT);
                b.build()
            },
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[push] vapid sign failed: {e}");
                continue;
            }
        };
        let mut builder = WebPushMessageBuilder::new(&info);
        builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
        builder.set_vapid_signature(sig);
        let msg = match builder.build() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[push] message build failed: {e}");
                continue;
            }
        };
        match client.send(msg).await {
            Ok(_) => sent += 1,
            Err(WebPushError::EndpointNotValid(..)) | Err(WebPushError::EndpointNotFound(..)) => {
                dead.push(sub.endpoint.clone());
            }
            Err(e) => eprintln!("[push] send failed: {e}"),
        }
    }
    if !dead.is_empty() {
        let mut live = state.subs.lock().await;
        live.retain(|s| !dead.contains(&s.endpoint));
        persist_subs(state, &live);
    }
    sent
}

// ---- helpers ----------------------------------------------------------

/// Map a tmux pane id (`%N`) → its session name, via `tmux list-panes`.
fn resolve_session(socket: Option<&str>, pane: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    cmd.arg("list-panes")
        .arg("-a")
        .arg("-F")
        .arg("#{pane_id}\t#{session_name}");
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut it = line.splitn(2, '\t');
        if let (Some(id), Some(name)) = (it.next(), it.next()) {
            if id == pane {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Ensure a VAPID keypair exists under `push_dir`; return (private PEM
/// bytes, base64url public key for `applicationServerKey`). Generated with
/// the `openssl` CLI on first run — produces a SEC1 EC PEM web-push parses,
/// and the uncompressed P-256 point we hand the browser.
fn ensure_vapid(push_dir: &std::path::Path) -> anyhow::Result<(Vec<u8>, String)> {
    let pem_path = push_dir.join("vapid_private.pem");
    let pub_path = push_dir.join("vapid_public.txt");
    if !pem_path.exists() {
        let st = std::process::Command::new("openssl")
            .args(["ecparam", "-name", "prime256v1", "-genkey", "-noout"])
            .output()?;
        anyhow::ensure!(st.status.success(), "openssl keygen failed");
        std::fs::write(&pem_path, &st.stdout)?;
        restrict_file(&pem_path);
    }
    let pem = std::fs::read(&pem_path)?;

    // Derive the uncompressed public point: SPKI DER for P-256 is a fixed
    // 26-byte prefix followed by the 65-byte 0x04||X||Y point.
    let der = std::process::Command::new("openssl")
        .args(["ec", "-pubout", "-outform", "DER"])
        .arg("-in")
        .arg(&pem_path)
        .output()?;
    anyhow::ensure!(der.status.success(), "openssl pubkey export failed");
    let bytes = der.stdout;
    anyhow::ensure!(bytes.len() >= 65, "unexpected SPKI length");
    let point = &bytes[bytes.len() - 65..];
    let pub_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(point);
    std::fs::write(&pub_path, &pub_b64)?;
    Ok((pem, pub_b64))
}

fn persist_subs(state: &Arc<PushState>, subs: &[Subscription]) {
    write_json(&state.push_dir.join("subscriptions.json"), &subs);
}

fn load_json<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Option<T> {
    let data = std::fs::read(path).ok()?;
    serde_json::from_slice(&data).ok()
}

fn write_json<T: Serialize>(path: &std::path::Path, value: &T) {
    if let Ok(data) = serde_json::to_vec_pretty(value) {
        let _ = std::fs::write(path, data);
        restrict_file(path);
    }
}

#[cfg(unix)]
fn restrict_file(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(unix)]
fn restrict_dir(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn restrict_file(_: &std::path::Path) {}
#[cfg(not(unix))]
fn restrict_dir(_: &std::path::Path) {}
