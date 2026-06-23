//! download — serve a host file by path for one-tap downloads from the
//! terminal.
//!
//! Mounted on the daemon via ttyview-core's `RunOptions.extra_api` hook (the
//! same lane as cc-search). The client (cell-grid Download action / linkify)
//! points the browser at:
//!
//!   GET /api/download?path=<abs-or-~ path>[&name=<override>]
//!     → sends the file (read into memory, capped) with
//!       `Content-Disposition: attachment`.
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

/// True if any component of `path` is a dotfile/dotdir (a name starting with
/// '.'). Intended for the CANONICAL path (canonicalize resolves `.`/`..`, so a
/// remaining leading-dot component is a genuine hidden name, never a traversal
/// artefact). Uses lossy UTF-8 — a leading ASCII '.' (0x2E) always survives, so
/// a non-UTF8 dotfile name can't slip through.
fn has_hidden_component(path: &FsPath) -> bool {
    use std::path::Component;
    path.components().any(|c| match c {
        Component::Normal(os) => os.to_string_lossy().starts_with('.'),
        _ => false,
    })
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

/// Read a file into memory, enforcing the byte cap AT READ TIME (the `metadata`
/// size check is advisory — the file could grow between the check and the read,
/// so we re-cap here rather than trust the earlier length). Reads one byte past
/// the cap to detect an over-size file and reject instead of buffering it.
fn read_capped(path: &FsPath, cap: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let f = std::fs::File::open(path)?;
    let mut buf = Vec::new();
    f.take(cap + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > cap {
        return Err(std::io::Error::other("file exceeds size cap"));
    }
    Ok(buf)
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

    // Deny any path with a hidden (dotfile/dotdir) component. This subsumes the
    // sensitive-subtree denylist in one rule — ~/.ssh, ~/.config/mobile-cc (the
    // VAPID private key + push subs), ~/.aws, ~/.gnupg, ~/.netrc … are all
    // dotpaths. Checked on the CANONICAL path so a non-hidden symlink that
    // resolves into a dotpath can't dodge it (canonicalize has already resolved
    // `.`/`..`, so any remaining leading-dot component is a genuine hidden name).
    // Returns 404 (not 403) so a hidden file's existence isn't confirmed.
    // Tradeoff (accepted): a deliberately-hidden dotfile can't be tap-downloaded.
    if has_hidden_component(&canonical) {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    // Enforce the allowlist BEFORE touching metadata, so the existence, type,
    // and size of out-of-root paths aren't distinguishable (a 403 here vs a 404
    // / 413 below would let a caller probe arbitrary paths). `Path::starts_with`
    // is component-wise, so /home/eyalevil does NOT match root /home/eyalev — no
    // prefix-escape.
    let allowed = cfg.roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|r| canonical.starts_with(&r))
            .unwrap_or(false)
    });
    if !allowed {
        return (StatusCode::FORBIDDEN, "path not in an allowed directory").into_response();
    }

    let meta = match std::fs::metadata(&canonical) {
        Ok(m) if m.is_file() => m,
        Ok(_) => return (StatusCode::NOT_FOUND, "not a regular file").into_response(),
        Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };
    if meta.len() > MAX_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, "file too large to download").into_response();
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
    let bytes = match tokio::task::spawn_blocking(move || read_capped(&path2, MAX_BYTES)).await {
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
        assert_eq!(
            expand_tilde("~/a/b", Some(&home)),
            PathBuf::from("/home/u/a/b")
        );
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
        assert_eq!(
            content_type_for(FsPath::new("/x/n")),
            "application/octet-stream"
        );
    }

    #[test]
    fn sanitize_strips_quote_and_newlines() {
        assert_eq!(sanitize_filename("a\"b\nc"), "abc");
    }

    #[test]
    fn read_capped_allows_within_cap_and_rejects_over() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("mcc-dl-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("f.bin");
        std::fs::File::create(&p)
            .unwrap()
            .write_all(&[0u8; 100])
            .unwrap();
        // Under cap → returns the bytes.
        assert_eq!(read_capped(&p, 1000).unwrap().len(), 100);
        // Exactly at cap → ok.
        assert_eq!(read_capped(&p, 100).unwrap().len(), 100);
        // Over cap → error, not a truncated/unbounded buffer.
        assert!(read_capped(&p, 50).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_component_detects_dotpaths() {
        // Dotfile / dotdir anywhere in the path → hidden.
        assert!(has_hidden_component(FsPath::new("/home/u/.ssh/id_rsa")));
        assert!(has_hidden_component(FsPath::new(
            "/home/u/.config/mobile-cc/push/vapid_private.pem"
        )));
        assert!(has_hidden_component(FsPath::new("/home/u/.netrc")));
        // Normal paths → allowed.
        assert!(!has_hidden_component(FsPath::new("/home/u/project/app.apk")));
        assert!(!has_hidden_component(FsPath::new("/home/u/Downloads/log.txt")));
        // A dot mid-name (not a leading-dot component) is NOT hidden.
        assert!(!has_hidden_component(FsPath::new("/home/u/v1.2.3/build.zip")));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_dotpath_is_hidden_after_canonicalize() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("mcc-hidden-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let secret = dir.join(".secret");
        std::fs::write(&secret, b"x").unwrap();
        let link = dir.join("innocent"); // non-hidden NAME …
        symlink(&secret, &link).unwrap(); // … pointing at a dotfile

        // The link's own path is NOT hidden — so the deny MUST run on the
        // canonical target (which resolves to the dotfile) to catch the dodge.
        assert!(!has_hidden_component(&link));
        let canonical = std::fs::canonicalize(&link).unwrap();
        assert!(has_hidden_component(&canonical));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
