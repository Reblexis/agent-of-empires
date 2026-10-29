//! Ask pages: the HTML a session posts with its Inbox ask, what the user needs
//! to know for it. One file per session under `<app_dir>/ask-pages/`, never in
//! `sessions.json`. The ask's `page` flag says whether the current ask has
//! one. Spec: docs/guides/session-inbox.md.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// A page is at most this many bytes.
pub const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;
/// A request's context is at most this many bytes.
pub const MAX_CONTEXT_BYTES: usize = 256 * 1024;
const DIR_NAME: &str = "ask-pages";

pub fn pages_dir() -> Result<PathBuf> {
    Ok(super::get_app_dir()?.join(DIR_NAME))
}

/// The page file for `id`. The id is checked first, so a page path can never
/// leave the pages directory.
fn page_path(dir: &Path, id: &str) -> Result<PathBuf> {
    super::validate_instance_id(id).context("invalid session id for an ask page")?;
    Ok(dir.join(format!("{id}.html")))
}

/// Read a page the agent wrote, refusing one over the size cap.
pub fn read_source(path: &Path) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    let mut html = Vec::new();
    file.take(MAX_PAGE_BYTES as u64 + 1)
        .read_to_end(&mut html)
        .with_context(|| format!("read {}", path.display()))?;
    if html.len() > MAX_PAGE_BYTES {
        bail!("an ask page is at most 4 MiB: {}", path.display());
    }
    Ok(html)
}

/// Replace the page atomically.
pub fn write_page_in(dir: &Path, id: &str, html: &[u8]) -> Result<()> {
    let path = page_path(dir, id)?;
    if html.len() > MAX_PAGE_BYTES {
        bail!("an ask page is at most 4 MiB");
    }
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    super::atomic_write(&path, html)
}

pub fn read_page_in(dir: &Path, id: &str) -> Result<Option<Vec<u8>>> {
    let path = page_path(dir, id)?;
    match std::fs::read(&path) {
        Ok(html) => Ok(Some(html)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

pub fn clear_page_in(dir: &Path, id: &str) -> Result<()> {
    let path = page_path(dir, id)?;
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(e).with_context(|| format!("remove {}", path.display()))
        }
        _ => Ok(()),
    }
}

/// The session id a `<id>.html` page or `<id>.context` belongs to, or `None`
/// for any other entry.
fn page_id(entry: &std::fs::DirEntry) -> Option<String> {
    let name = entry.file_name();
    let name = name.to_str()?;
    let id = name
        .strip_suffix(".html")
        .or_else(|| name.strip_suffix(".context"))?;
    super::validate_instance_id(id).ok()?;
    Some(id.to_string())
}

/// Remove every page whose session id is not in `live`. Returns how many.
pub fn prune_orphans_in(dir: &Path, live: &HashSet<String>) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| page_id(entry).is_some_and(|id| !live.contains(&id)))
        .filter(|entry| std::fs::remove_file(entry.path()).is_ok())
        .count()
}

/// Read a request's context file, refusing one over 256 KiB or not UTF-8.
pub fn read_context_source(path: &Path) -> Result<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_CONTEXT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {}", path.display()))?;
    if bytes.len() > MAX_CONTEXT_BYTES {
        bail!("a request's context is at most 256 KiB: {}", path.display());
    }
    String::from_utf8(bytes).with_context(|| format!("{} is not UTF-8 text", path.display()))
}

fn context_path(dir: &Path, id: &str) -> Result<PathBuf> {
    super::validate_instance_id(id).context("invalid session id for a request context")?;
    Ok(dir.join(format!("{id}.context")))
}

pub fn write_context_in(dir: &Path, id: &str, text: &str) -> Result<()> {
    let path = context_path(dir, id)?;
    if text.len() > MAX_CONTEXT_BYTES {
        bail!("a request's context is at most 256 KiB");
    }
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    super::atomic_write(&path, text.as_bytes())
}

pub fn read_context_in(dir: &Path, id: &str) -> Result<Option<String>> {
    let path = context_path(dir, id)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

pub fn clear_context_in(dir: &Path, id: &str) -> Result<()> {
    let path = context_path(dir, id)?;
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(e).with_context(|| format!("remove {}", path.display()))
        }
        _ => Ok(()),
    }
}

pub fn write_context(id: &str, text: &str) -> Result<()> {
    write_context_in(&pages_dir()?, id, text)
}

pub fn read_context(id: &str) -> Result<Option<String>> {
    read_context_in(&pages_dir()?, id)
}

pub fn clear_context(id: &str) -> Result<()> {
    clear_context_in(&pages_dir()?, id)
}

pub fn write_page(id: &str, html: &[u8]) -> Result<()> {
    write_page_in(&pages_dir()?, id, html)
}

pub fn read_page(id: &str) -> Result<Option<Vec<u8>>> {
    read_page_in(&pages_dir()?, id)
}

pub fn clear_page(id: &str) -> Result<()> {
    clear_page_in(&pages_dir()?, id)
}

/// Daemon-start cleanup: remove the pages of sessions that no longer exist in
/// any profile. Removes nothing when a profile cannot be read.
pub fn prune_orphans() -> Result<usize> {
    let live = super::forecast::all_session_ids()?;
    Ok(prune_orphans_in(&pages_dir()?, &live))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_written_read_replaced_and_cleared_per_session() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(DIR_NAME);
        assert_eq!(read_page_in(&dir, "aaaa1111").unwrap(), None);
        write_page_in(&dir, "aaaa1111", b"<p>first</p>").unwrap();
        write_page_in(&dir, "bbbb2222", b"<p>other</p>").unwrap();
        write_page_in(&dir, "aaaa1111", b"<p>second</p>").unwrap();
        assert_eq!(
            read_page_in(&dir, "aaaa1111").unwrap().as_deref(),
            Some(&b"<p>second</p>"[..])
        );
        clear_page_in(&dir, "aaaa1111").unwrap();
        clear_page_in(&dir, "aaaa1111").unwrap();
        assert_eq!(read_page_in(&dir, "aaaa1111").unwrap(), None);
        assert_eq!(
            read_page_in(&dir, "bbbb2222").unwrap().as_deref(),
            Some(&b"<p>other</p>"[..])
        );
        for bad in ["../escape", "a/b", ""] {
            assert!(write_page_in(&dir, bad, b"x").is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_page_over_4_mib_or_unreadable_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let fits = tmp.path().join("fits.html");
        std::fs::write(&fits, vec![b'x'; MAX_PAGE_BYTES]).unwrap();
        assert_eq!(read_source(&fits).unwrap().len(), MAX_PAGE_BYTES);
        let big = tmp.path().join("big.html");
        std::fs::write(&big, vec![b'x'; MAX_PAGE_BYTES + 1]).unwrap();
        assert!(format!("{:#}", read_source(&big).unwrap_err()).contains("4 MiB"));
        assert!(read_source(&tmp.path().join("missing.html")).is_err());
    }

    #[test]
    fn a_requests_context_is_kept_beside_its_page_and_capped_at_256_kib() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(DIR_NAME);
        assert_eq!(read_context_in(&dir, "aaaa1111").unwrap(), None);
        write_context_in(&dir, "aaaa1111", "budget notes").unwrap();
        write_page_in(&dir, "aaaa1111", b"<p>page</p>").unwrap();
        assert_eq!(
            read_context_in(&dir, "aaaa1111").unwrap().as_deref(),
            Some("budget notes")
        );
        clear_context_in(&dir, "aaaa1111").unwrap();
        assert_eq!(read_context_in(&dir, "aaaa1111").unwrap(), None);
        assert!(
            read_page_in(&dir, "aaaa1111").unwrap().is_some(),
            "the page stays"
        );
        assert!(write_context_in(&dir, "../x", "y").is_err());
        let fits = tmp.path().join("fits.md");
        std::fs::write(&fits, "x".repeat(MAX_CONTEXT_BYTES)).unwrap();
        assert_eq!(read_context_source(&fits).unwrap().len(), MAX_CONTEXT_BYTES);
        let big = tmp.path().join("big.md");
        std::fs::write(&big, "x".repeat(MAX_CONTEXT_BYTES + 1)).unwrap();
        assert!(format!("{:#}", read_context_source(&big).unwrap_err()).contains("256 KiB"));
        let binary = tmp.path().join("bin.md");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_context_source(&binary).is_err());
    }

    #[test]
    fn prune_removes_pages_whose_session_is_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(DIR_NAME);
        write_page_in(&dir, "aaaa1111", b"keep").unwrap();
        write_page_in(&dir, "bbbb2222", b"gone").unwrap();
        write_context_in(&dir, "bbbb2222", "gone").unwrap();
        write_context_in(&dir, "aaaa1111", "keep").unwrap();
        std::fs::write(dir.join("stray.txt"), b"not a page").unwrap();
        let live = HashSet::from(["aaaa1111".to_string()]);
        assert_eq!(prune_orphans_in(&dir, &live), 2);
        assert!(read_context_in(&dir, "bbbb2222").unwrap().is_none());
        assert!(read_context_in(&dir, "aaaa1111").unwrap().is_some());
        assert!(read_page_in(&dir, "aaaa1111").unwrap().is_some());
        assert!(read_page_in(&dir, "bbbb2222").unwrap().is_none());
        assert!(dir.join("stray.txt").exists());
    }
}
