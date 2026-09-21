use std::path::{Path, PathBuf};

pub struct VectorDBState {
    pub base_dir: PathBuf,
}

impl VectorDBState {
    /// Where collections lived before they followed the app's data folder: a fixed place under
    /// the system data directory, whatever data folder the user had chosen.
    pub fn legacy_dir() -> PathBuf {
        let mut base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        base.push("Atomic Chat");
        base.push("data");
        base.push("db");
        base
    }

    /// Collections in the legacy place. Kept for hosts that have no data folder of their own.
    pub fn new() -> Self {
        Self::at(Self::legacy_dir())
    }

    /// Collections in `base_dir`, which the app derives from its data folder so that they move,
    /// and are reset, with everything else the user owns. Collections still in the legacy place
    /// are brought over first.
    pub fn at(base_dir: PathBuf) -> Self {
        std::fs::create_dir_all(&base_dir).ok();
        let moved = adopt_collections(&Self::legacy_dir(), &base_dir);
        if moved > 0 {
            log::info!("[vector-db] moved {moved} collection file(s) into {base_dir:?}");
        }
        Self { base_dir }
    }
}

/// Move every file of `from` into `to`, leaving alone what `to` already has — a collection that
/// exists in both places was created after the move, and is the one in use. Returns how many
/// files moved. A collection is a SQLite file with optional `-wal`/`-shm` companions; they are
/// plain files here and travel together because all of them are moved.
fn adopt_collections(from: &Path, to: &Path) -> usize {
    if from == to {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(from) else {
        return 0;
    };
    let mut moved = 0;
    for entry in entries.flatten() {
        let source = entry.path();
        if !source.is_file() {
            continue;
        }
        let target = to.join(entry.file_name());
        if target.exists() {
            continue;
        }
        // A data folder on another volume cannot be renamed into; copy, then remove.
        let done = std::fs::rename(&source, &target).is_ok()
            || (std::fs::copy(&source, &target).is_ok() && std::fs::remove_file(&source).is_ok());
        if done {
            moved += 1;
        } else {
            log::warn!("[vector-db] could not move {source:?} into {to:?}");
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collections_are_brought_over_once_and_newer_ones_are_kept() {
        let legacy = tempfile::tempdir().unwrap();
        let current = tempfile::tempdir().unwrap();
        std::fs::write(legacy.path().join("attachments_a.db"), "old a").unwrap();
        std::fs::write(legacy.path().join("attachments_a.db-wal"), "old a wal").unwrap();
        std::fs::write(legacy.path().join("attachments_b.db"), "old b").unwrap();
        std::fs::write(current.path().join("attachments_b.db"), "new b").unwrap();

        assert_eq!(adopt_collections(legacy.path(), current.path()), 2);

        let read = |dir: &Path, name: &str| std::fs::read_to_string(dir.join(name)).ok();
        assert_eq!(read(current.path(), "attachments_a.db").as_deref(), Some("old a"));
        assert_eq!(read(current.path(), "attachments_a.db-wal").as_deref(), Some("old a wal"));
        assert_eq!(read(current.path(), "attachments_b.db").as_deref(), Some("new b"));
        assert_eq!(read(legacy.path(), "attachments_a.db"), None);
        assert_eq!(read(legacy.path(), "attachments_b.db").as_deref(), Some("old b"));

        assert_eq!(adopt_collections(legacy.path(), current.path()), 0);
    }

    #[test]
    fn the_same_place_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("attachments_a.db"), "a").unwrap();
        assert_eq!(adopt_collections(dir.path(), dir.path()), 0);
        assert!(dir.path().join("attachments_a.db").exists());
    }
}
