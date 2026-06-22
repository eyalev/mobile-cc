//! download — serve a host file by path for one-tap downloads from the
//! terminal.
//!
//! Mounted on the daemon via ttyview-core's `RunOptions.extra_api` hook (the
//! same lane as cc-search). The client (cell-grid Download action / linkify)
//! points the browser at:
//!
//!   GET /api/download?path=<abs-or-~ path>[&name=<override>]
//!     → streams the file with `Content-Disposition: attachment`.
//!
//! Security: only files that canonicalize to *under one of `roots`* are
//! served; `..`/symlink escapes are rejected post-canonicalization. mobile-cc
//! passes `roots = [$HOME]`, consistent with its single-user threat model —
//! whoever can reach the UI already has a shell in the pane, so home-dir read
//! is not a new capability. The route simply doesn't exist for any embedder
//! that doesn't mount it.

use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Extension, Query},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;

/// Cap the in-memory read so a stray huge path can't OOM the daemon. Build
/// artifacts (APKs, archives, logs, images) sit well under this; anything
/// larger should be fetched another way.
const MAX_BYTES: u64 = 256 * 1024 * 1024; // 256 MiB

#[derive(Clone)]
pub struct DownloadConfig {
    /// Allowlisted roots. A requested path must canonicalize to under one.
    pub roots: Vec<PathBuf>,
    /// Home dir for `~` expansion. `None` disables `~` handling.
    pub home: Option<PathBuf>,
}

/// Build the `extra_api` closure ttyview-core applies to its router.
pub fn extra_api(cfg: DownloadConfig) -> Box<dyn FnOnce(Router) -> Router + Send> {
    Box::new(move |router: Router| {
        router
            .route("/api/download", get(download))
            .layer(Extension(Arc::new(cfg)))
    })
}

#[derive(Deserialize)]
struct DownloadQuery {
    path: String,
    /// Optional download filename override (basename only).
    #[serde(default)]
    name: Option<String>,
}

fn expand_tilde(input: &str, home: Option<&FsPath>) -> PathBuf {
    if let Some(home) = home {
        if input == "~" {
            return home.to_path_buf();
        }
        if let Some(rest) = input.strip_prefix("~/") {
            return home.join(rest);
        }
    }
    PathBuf::from(input)
}

fn content_type_for(path: &FsPath) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("apk") => "application/vnd.android.package-archive",
        Some("zip") => "application/zip",
        Some("gz") | Some("tgz") => "application/gzip",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("pdf") => "application/pdf",
        Some("txt") | Some("log") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

/// Strip characters that would break the `Content-Disposition` header.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .filter(|c| !matches!(c, '"' | '\n' | '\r'))
        .collect()
}

async fn download(
    Extension(cfg): Extension<Arc<DownloadConfig>>,
    Query(q): Query<DownloadQuery>,
) -> Response {
    let requested = expand_tilde(q.path.trim(), cfg.home.as_deref());

    // Canonicalize to resolve `..` and symlinks before the allowlist check.
    let canonical = match std::fs::canonicalize(&requested) {
        Ok(p) => p,
        Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };

    let meta = match std::fs::metadata(&canonical) {
        Ok(m) if m.is_file() => m,
        Ok(_) => return (StatusCode::NOT_FOUND, "not a regular file").into_response(),
        Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };
    if meta.len() > MAX_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "file too large to download").into_response();
    }

    // Enforce the allowlist: canonical must be inside a canonicalized root.
    // `Path::starts_with` is component-wise, so /home/eyalevil does NOT match
    // root /home/eyalev — no prefix-escape.
    let allowed = cfg.roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|r| canonical.starts_with(&r))
            .unwrap_or(false)
    });
    if !allowed {
        return (StatusCode::FORBIDDEN, "path not in an allowed directory").into_response();
    }

    let ct = content_type_for(&canonical);
    let filename = q
        .name
        .filter(|n| !n.is_empty() && !n.contains('/') && !n.contains('\\'))
        .or_else(|| {
            canonical
                .file_name()
                .and_then(|n| n.to_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "download".to_string());

    let path2 = canonical.clone();
    let bytes = match tokio::task::spawn_blocking(move || std::fs::read(&path2)).await {
        Ok(Ok(b)) => b,
        _ => return (StatusCode::INTERNAL_SERVER_ERROR, "read failed").into_response(),
    };

    let disposition = format!("attachment; filename=\"{}\"", sanitize_filename(&filename));
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, ct.to_string()),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CONTENT_LENGTH, bytes.len().to_string()),
        ],
        Body::from(bytes),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_expands_to_home() {
        let home = PathBuf::from("/home/u");
        assert_eq!(expand_tilde("~", Some(&home)), home);
        assert_eq!(expand_tilde("~/a/b", Some(&home)), PathBuf::from("/home/u/a/b"));
        // No home → left as-is.
        assert_eq!(expand_tilde("~/a", None), PathBuf::from("~/a"));
        // Non-tilde paths untouched.
        assert_eq!(expand_tilde("/abs/p", Some(&home)), PathBuf::from("/abs/p"));
    }

    #[test]
    fn content_type_maps_known_extensions() {
        assert_eq!(
            content_type_for(FsPath::new("/x/app.apk")),
            "application/vnd.android.package-archive"
        );
        assert_eq!(content_type_for(FsPath::new("/x/a.PNG")), "image/png");
        assert_eq!(content_type_for(FsPath::new("/x/n")), "application/octet-stream");
    }

    #[test]
    fn sanitize_strips_quote_and_newlines() {
        assert_eq!(sanitize_filename("a\"b\nc"), "abc");
    }
}
