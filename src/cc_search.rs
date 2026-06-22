//! cc-search — search Claude Code transcripts and recommend the tab/session
//! you worked on.
//!
//! Mounted on the daemon via ttyview-core's `RunOptions.extra_api` hook (a
//! plain `FnOnce(Router) -> Router`). Plugins are client JS and can't read
//! host files, so the actual search lives here, server-side. Config is
//! carried through an `axum::Extension` layer — no coupling to ttyview-core's
//! private `AppState`.
//!
//! Routes:
//!   GET /api/cc-search?q=<query>&limit=<n>  → ranked SearchResult[]
//!   GET /api/cc-session/:id                 → messages[] for preview
//!
//! Search = ripgrep-on-demand over `~/.claude/projects/<dashes>/*.jsonl`
//! (no index/embeddings). Keyword + recency ranking, weighting the user's
//! OWN prompts higher (best "what I worked on" signal). Open tabs are
//! detected by matching each session's `cwd` against live tmux panes, so the
//! client can jump straight to a running tab. Design notes:
//! `.claude/cc-search.md`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use axum::{
    extract::{Extension, Path, Query},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};

/// Per-instance config for the cc-search routes, shared via Extension.
#[derive(Clone)]
pub struct CcSearchConfig {
    /// `~/.claude/projects` — the root of all CC transcript dirs.
    pub projects_root: PathBuf,
    /// tmux `-L` socket name (so open-tab detection hits the right server).
    pub tmux_socket: Option<String>,
}

/// Build the `extra_api` closure ttyview-core applies to its router.
pub fn extra_api(cfg: CcSearchConfig) -> Box<dyn FnOnce(Router) -> Router + Send> {
    Box::new(move |router: Router| {
        router
            .route("/api/cc-search", get(cc_search))
            .route("/api/cc-session/:id", get(cc_session))
            .layer(Extension(Arc::new(cfg)))
    })
}

// ---- /api/cc-search ----------------------------------------------------

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Serialize)]
struct SearchResult {
    session_id: String,
    cwd: String,
    /// tmux session name when open, else the cwd's basename.
    label: String,
    /// ISO timestamp of the most recent matching message.
    date: String,
    /// Best matching excerpt (prefers the user's own prompts).
    snippet: String,
    /// role of the snippet message: "user" | "assistant".
    role: String,
    match_count: usize,
    /// 0..1 token coverage + bonuses — for display/debug only.
    score: f64,
    /// true when this session's cwd matches a live tmux pane.
    open: bool,
    /// tmux pane id (e.g. "%6") for `tv.selectPane()` when open.
    pane_id: Option<String>,
    tmux_name: Option<String>,
}

async fn cc_search(
    Extension(cfg): Extension<Arc<CcSearchConfig>>,
    Query(q): Query<SearchQuery>,
) -> axum::response::Response {
    let limit = q.limit.unwrap_or(20).min(50);
    let query = q.q.trim().to_string();
    if query.is_empty() {
        return Json(Vec::<SearchResult>::new()).into_response();
    }
    let cfg2 = cfg.clone();
    match tokio::task::spawn_blocking(move || run_search(&cfg2, &query, limit)).await {
        Ok(Ok(results)) => Json(results).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("search task failed: {e}"),
        )
            .into_response(),
    }
}

/// Per-session running aggregate while scanning rg matches.
struct Agg {
    cwd: String,
    latest_ts: String,
    match_count: usize,
    tokens: HashSet<usize>, // indices into the token list
    best_snippet: String,
    best_role: String,
    best_token_hits: usize,
    best_is_user: bool,
}

fn run_search(cfg: &CcSearchConfig, query: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
    let tokens = tokenize(query);
    if tokens.is_empty() {
        return Ok(Vec::new());
    }

    // One rg pass: OR of the (regex-escaped) tokens, case-insensitive,
    // over *.jsonl under the projects root. --json gives us file path +
    // the full matched line, which we re-parse as a CC record.
    // `\b`-anchor each token to a word START so a short token like "ux"
    // matches the word "ux" but NOT the "ux" inside "tmux"/"Linux". Still
    // prefix-matches ("attach" hits "attachments"), which is the forgiving
    // behavior we want for prose.
    let pattern = tokens
        .iter()
        .map(|t| format!("\\b{}", regex_escape(t)))
        .collect::<Vec<_>>()
        .join("|");

    let mut cmd = Command::new("rg");
    cmd.arg("--json")
        .arg("-i")
        .arg("--no-ignore")
        .arg("-g")
        .arg("*.jsonl")
        .arg("-e")
        .arg(&pattern)
        .arg(&cfg.projects_root);

    let out = cmd
        .output()
        .map_err(|e| format!("ripgrep (rg) not available: {e}"))?;
    // rg exits 1 when there are zero matches — that's not an error.
    if !out.status.success() && out.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ripgrep failed: {stderr}"));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);

    let mut aggs: HashMap<String, Agg> = HashMap::new();
    let mut processed = 0usize;
    const MAX_MATCHES: usize = 8000;

    for line in stdout.lines() {
        if processed >= MAX_MATCHES {
            break;
        }
        let ev: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if ev.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }
        let data = match ev.get("data") {
            Some(d) => d,
            None => continue,
        };
        let raw = data
            .get("lines")
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        if raw.is_empty() {
            continue;
        }
        let rec: serde_json::Value = match serde_json::from_str(raw.trim_end()) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let rtype = rec.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if rtype != "user" && rtype != "assistant" {
            continue;
        }
        let text = extract_text(&rec);
        if text.is_empty() {
            continue;
        }
        // Re-check tokens against the CLEAN content text — this drops rg
        // matches that only hit metadata (cwd paths, uuids, field names).
        let lower = text.to_lowercase();
        let hit_idx: HashSet<usize> = tokens
            .iter()
            .enumerate()
            .filter(|(_, t)| contains_word_start(&lower, t))
            .map(|(i, _)| i)
            .collect();
        if hit_idx.is_empty() {
            continue;
        }
        processed += 1;

        let sid = rec
            .get("sessionId")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        if sid.is_empty() {
            continue;
        }
        let cwd = rec
            .get("cwd")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let ts = rec
            .get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let is_user = rtype == "user";
        let snippet = make_snippet(&text, &tokens);

        let agg = aggs.entry(sid).or_insert_with(|| Agg {
            cwd: cwd.clone(),
            latest_ts: ts.clone(),
            match_count: 0,
            tokens: HashSet::new(),
            best_snippet: String::new(),
            best_role: String::new(),
            best_token_hits: 0,
            best_is_user: false,
        });
        agg.match_count += 1;
        for i in &hit_idx {
            agg.tokens.insert(*i);
        }
        if !cwd.is_empty() {
            agg.cwd = cwd;
        }
        if ts > agg.latest_ts {
            agg.latest_ts = ts;
        }
        // Best snippet: prefer user prompts; within a role, prefer more
        // distinct tokens hit in that single message.
        let better = (is_user && !agg.best_is_user)
            || (is_user == agg.best_is_user && hit_idx.len() > agg.best_token_hits);
        if better || agg.best_snippet.is_empty() {
            agg.best_snippet = snippet;
            agg.best_role = rtype.to_string();
            agg.best_token_hits = hit_idx.len();
            agg.best_is_user = is_user;
        }
    }

    // Map open tmux panes by cwd so the client can jump to a live tab.
    let open_by_cwd = tmux_open_panes(cfg.tmux_socket.as_deref());

    let total = tokens.len() as f64;
    let mut results: Vec<SearchResult> = aggs
        .into_iter()
        .map(|(sid, a)| {
            // coverage   = distinct query tokens seen anywhere in the session.
            // concentration = most tokens hit within a SINGLE message — this
            //   is what separates "talked about image-attachment-ux as a
            //   topic" from a session that merely happens to contain those
            //   three words scattered across unrelated turns.
            let coverage = a.tokens.len() as f64 / total;
            let concentration = a.best_token_hits as f64 / total;
            let user_bonus = if a.best_is_user { 0.15 } else { 0.0 };
            let score = 0.6 * coverage + 0.4 * concentration + user_bonus;
            let (open, pane_id, tmux_name) = match open_by_cwd.get(&a.cwd) {
                Some((name, pid)) => (true, Some(pid.clone()), Some(name.clone())),
                None => (false, None, None),
            };
            let label = tmux_name
                .clone()
                .unwrap_or_else(|| basename(&a.cwd).to_string());
            SearchResult {
                session_id: sid,
                cwd: a.cwd,
                label,
                date: a.latest_ts,
                snippet: a.best_snippet,
                role: a.best_role,
                match_count: a.match_count,
                score: (score * 1000.0).round() / 1000.0,
                open,
                pane_id,
                tmux_name,
            }
        })
        .collect();

    // Rank: score desc, then recency (ISO ts sorts lexically), then open
    // tabs ahead of closed on ties.
    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.date.cmp(&a.date))
            .then(b.open.cmp(&a.open))
    });
    results.truncate(limit);
    Ok(results)
}

// ---- /api/cc-session/:id (preview) ------------------------------------

#[derive(Serialize)]
struct PreviewMsg {
    role: String,
    ts: String,
    text: String,
}

async fn cc_session(
    Extension(cfg): Extension<Arc<CcSearchConfig>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    // Hard guard against path traversal — session ids are uuids.
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return (StatusCode::BAD_REQUEST, "invalid session id").into_response();
    }
    let cfg2 = cfg.clone();
    match tokio::task::spawn_blocking(move || load_session(&cfg2, &id)).await {
        Ok(Ok(msgs)) => Json(msgs).into_response(),
        Ok(Err(e)) => (StatusCode::NOT_FOUND, e).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("preview task failed: {e}"),
        )
            .into_response(),
    }
}

fn load_session(cfg: &CcSearchConfig, id: &str) -> Result<Vec<PreviewMsg>, String> {
    let file_name = format!("{id}.jsonl");
    let mut found: Option<PathBuf> = None;
    if let Ok(dirs) = std::fs::read_dir(&cfg.projects_root) {
        for d in dirs.flatten() {
            let cand = d.path().join(&file_name);
            if cand.is_file() {
                found = Some(cand);
                break;
            }
        }
    }
    let path = found.ok_or_else(|| "session not found".to_string())?;
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;

    let mut msgs: Vec<PreviewMsg> = Vec::new();
    for line in content.lines() {
        let rec: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let rtype = rec.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if rtype != "user" && rtype != "assistant" {
            continue;
        }
        let text = extract_text(&rec);
        if text.is_empty() {
            continue;
        }
        let ts = rec
            .get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        msgs.push(PreviewMsg {
            role: rtype.to_string(),
            ts,
            text,
        });
    }
    // Cap to the most recent 400 messages so a huge session stays light.
    let n = msgs.len();
    if n > 400 {
        msgs = msgs.split_off(n - 400);
    }
    Ok(msgs)
}

// ---- helpers ----------------------------------------------------------

/// Lowercase tokens, length >= 2, de-duplicated, order-preserving.
fn tokenize(q: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for w in q.split(|c: char| !c.is_alphanumeric()) {
        let w = w.to_lowercase();
        if w.len() >= 2 && seen.insert(w.clone()) {
            out.push(w);
        }
    }
    // If the query was all 1-char/punct, fall back to the trimmed whole.
    if out.is_empty() {
        let w = q.trim().to_lowercase();
        if !w.is_empty() {
            out.push(w);
        }
    }
    out
}

/// Escape regex metacharacters so a token matches literally in rg.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if "\\.^$|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Pull human-readable text out of a CC record's message content.
/// String content → itself; array content → its `text` blocks joined
/// (thinking / tool_use / tool_result blocks are skipped).
fn extract_text(rec: &serde_json::Value) -> String {
    let content = match rec.get("message").and_then(|m| m.get("content")) {
        Some(c) => c,
        None => return String::new(),
    };
    let raw = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        arr.iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        String::new()
    };
    // Drop harness-injected wrappers that aren't the user's words.
    if raw.trim_start().starts_with("<local-command")
        || raw.trim_start().starts_with("<command-")
        || raw.trim_start().starts_with("Caveat:")
    {
        return String::new();
    }
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A ~220-char excerpt centered on the first matching token.
fn make_snippet(text: &str, tokens: &[String]) -> String {
    let lower = text.to_lowercase();
    let chars: Vec<char> = text.chars().collect();
    let lower_chars: Vec<char> = lower.chars().collect();
    // first token occurrence (by char index)
    let mut at = 0usize;
    let mut found = false;
    for t in tokens {
        if let Some(byte_pos) = lower.find(t.as_str()) {
            // translate byte pos → char index
            at = lower[..byte_pos].chars().count();
            found = true;
            break;
        }
    }
    let _ = lower_chars;
    let width = 220usize;
    let start = if found {
        at.saturating_sub(60)
    } else {
        0
    };
    let end = (start + width).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s.push('…');
    }
    s
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// True when `needle` appears in `hay` at a word START (preceded by a
/// non-alphanumeric byte or string start). Both args lowercase. Mirrors the
/// `\b<token>` rg pattern so the clean-text recheck agrees with the search.
/// Non-ASCII bytes count as boundaries (good enough for token prefixes).
fn contains_word_start(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let bytes = hay.as_bytes();
    let mut from = 0usize;
    while let Some(pos) = hay[from..].find(needle) {
        let abs = from + pos;
        let prev_ok = abs == 0 || !bytes[abs - 1].is_ascii_alphanumeric();
        if prev_ok {
            return true;
        }
        from = abs + 1;
        if from >= hay.len() {
            break;
        }
    }
    false
}

/// Map live tmux pane cwd → (session_name, pane_id). First pane wins per
/// cwd. Empty map on any tmux error (then everything reads as closed).
fn tmux_open_panes(socket: Option<&str>) -> HashMap<String, (String, String)> {
    let mut cmd = Command::new("tmux");
    if let Some(s) = socket {
        cmd.arg("-L").arg(s);
    }
    cmd.arg("list-panes")
        .arg("-a")
        .arg("-F")
        .arg("#{session_name}\t#{pane_id}\t#{pane_current_path}");
    let mut map = HashMap::new();
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                let mut parts = line.splitn(3, '\t');
                if let (Some(name), Some(pid), Some(cwd)) =
                    (parts.next(), parts.next(), parts.next())
                {
                    map.entry(cwd.to_string())
                        .or_insert_with(|| (name.to_string(), pid.to_string()));
                }
            }
        }
    }
    map
}
