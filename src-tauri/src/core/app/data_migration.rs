//! One-time move of the default data folder after the product rename.
//!
//! Builds before ADR 2026-09-13 shipped with `productName = "Atomic Chat"`, so
//! their default data folder is `<data_dir>/Atomic Chat/data`, and that
//! absolute path is saved in `settings.json`. Renaming `productName` only
//! changes the default for new installs: an existing install keeps reading the
//! saved path. This moves that folder to the new default and points every
//! `settings.json` at it, once, at startup, before anything opens a file in it.
//!
//! The move is deliberately conservative. A custom data folder is never
//! touched. It is a single `rename` on the same volume, never a copy, and
//! nothing that holds data is ever deleted. If the rename or a settings write
//! fails, everything is put back and the app keeps using the old folder, to try
//! again on the next launch.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use super::{
    commands::{build_default_data_folder, configuration_dirs, default_data_folder_path},
    constants::CONFIGURATION_FILE_NAME,
};

/// The `productName` every build before the rename shipped with, and so the
/// only name a launch-at-startup entry was ever registered under.
pub const LEGACY_PRODUCT_NAME: &str = "Atomic Chat";

/// Every name an old default data folder can have. "Atomic Chat" is the
/// shipped `productName`. "Radium Chat" was `jan-cli`'s fallback after the
/// first, partial rename (D13), and it can have created that folder, usually
/// empty, on its own.
pub const LEGACY_DATA_FOLDER_NAMES: &[&str] = &[LEGACY_PRODUCT_NAME, "Radium Chat"];

#[derive(Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    Moved {
        from: PathBuf,
        to: PathBuf,
        configs_updated: usize,
    },
    Skipped(SkipReason),
}

#[derive(Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// Unit tests and e2e runs, which must never move a real folder.
    Disabled,
    /// The platform reported no data directory to resolve the defaults in.
    NoDataDir(String),
    /// Every old default is the new default: the name has not changed.
    SameFolder,
    AlreadyMigrated,
    /// The user chose their own data folder, which stays exactly where it is.
    CustomDataFolder(PathBuf),
    /// Nothing lives at the old default, so there is nothing to move.
    LegacyFolderMissing(PathBuf),
    /// With no settings to say which, more than one old default holds data.
    /// Picking one would hide the other, so neither is moved.
    AmbiguousLegacyFolders(Vec<PathBuf>),
    /// Something that holds data already lives at the new default.
    TargetNotEmpty(PathBuf),
    RenameFailed(String),
    /// A settings file could not be rewritten, so the folder was moved back.
    ConfigWriteFailed(String),
}

/// Move an old default data folder to the current default, if this install
/// still uses it. Called once from `setup`, before the logger opens `logs/`.
pub fn migrate_default_data_folder<R: Runtime>(app: &AppHandle<R>) -> MigrationOutcome {
    if cfg!(test) || std::env::var("CI").unwrap_or_default() == "e2e" {
        return MigrationOutcome::Skipped(SkipReason::Disabled);
    }
    let data_dir = match app.path().data_dir() {
        Ok(dir) => dir,
        Err(err) => return MigrationOutcome::Skipped(SkipReason::NoDataDir(err.to_string())),
    };
    let candidates: Vec<PathBuf> = LEGACY_DATA_FOLDER_NAMES
        .iter()
        .map(|name| build_default_data_folder(&data_dir, name))
        .collect();
    let target = PathBuf::from(default_data_folder_path(app.clone()));
    migrate(&existing_config_files(app), &candidates, &target)
}

/// The `settings.json` files that exist, in the order the app reads them: the
/// legacy `CARGO_PKG_NAME` folder wins while it exists (see
/// `select_configuration_file_path`), then the identifier folder.
fn existing_config_files<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let (current, legacy) = configuration_dirs(app);
    [legacy, current]
        .into_iter()
        .map(|dir| dir.join(CONFIGURATION_FILE_NAME))
        .filter(|file| file.is_file())
        .collect()
}

/// Move the old default the configuration in effect still names (one of
/// `candidates`) to `target`, and repoint `config_files` (existing files, in
/// read order) at it.
pub fn migrate(config_files: &[PathBuf], candidates: &[PathBuf], target: &Path) -> MigrationOutcome {
    let legacy = match plan(config_files, candidates, target) {
        Ok(legacy) => legacy,
        Err(reason) => return MigrationOutcome::Skipped(reason),
    };

    // `plan` has established that anything at `target` holds no data.
    if target.exists() {
        if let Err(err) = fs::remove_dir_all(target) {
            return MigrationOutcome::Skipped(SkipReason::RenameFailed(format!(
                "could not clear the empty {}: {err}",
                target.display()
            )));
        }
    }
    if let Some(parent) = target.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            return MigrationOutcome::Skipped(SkipReason::RenameFailed(format!(
                "could not create {}: {err}",
                parent.display()
            )));
        }
    }
    if let Err(err) = fs::rename(&legacy, target) {
        return MigrationOutcome::Skipped(SkipReason::RenameFailed(err.to_string()));
    }

    match repoint_configs(config_files, &legacy, target) {
        Ok(configs_updated) => {
            // The old product folder is empty now, unless something else lived
            // beside `data`, in which case this does nothing.
            if let Some(parent) = legacy.parent() {
                let _ = fs::remove_dir(parent);
            }
            // Any other old default that holds nothing is the stray folder
            // `jan-cli` leaves behind. One that holds data is kept.
            for other in candidates
                .iter()
                .filter(|c| !same_path(c, &legacy) && !same_path(c, target))
            {
                if other.exists() && matches!(holds_no_data(other), Ok(true)) {
                    let _ = fs::remove_dir_all(other);
                    if let Some(parent) = other.parent() {
                        let _ = fs::remove_dir(parent);
                    }
                }
            }
            MigrationOutcome::Moved {
                from: legacy,
                to: target.to_path_buf(),
                configs_updated,
            }
        }
        Err(err) => {
            // The settings files are back as they were, so the folder must be too.
            let detail = match fs::rename(target, &legacy) {
                Ok(()) => err,
                Err(back) => format!(
                    "{err}; moving the folder back also failed ({back}), data is at {}",
                    target.display()
                ),
            };
            MigrationOutcome::Skipped(SkipReason::ConfigWriteFailed(detail))
        }
    }
}

/// Decide, without touching anything, which old default folder to move.
fn plan(config_files: &[PathBuf], candidates: &[PathBuf], target: &Path) -> Result<PathBuf, SkipReason> {
    let candidates: Vec<&PathBuf> = candidates.iter().filter(|c| !same_path(c, target)).collect();
    if candidates.is_empty() {
        return Err(SkipReason::SameFolder);
    }

    let legacy = match config_files.first().and_then(|file| configured_data_folder(file)) {
        Some(configured) => {
            if same_path(&configured, target) {
                return Err(SkipReason::AlreadyMigrated);
            }
            match candidates.iter().find(|c| same_path(c, &configured)) {
                Some(candidate) => (*candidate).clone(),
                None => return Err(SkipReason::CustomDataFolder(configured)),
            }
        }
        None => {
            // With no readable settings, the app used its default folder, so the
            // data a user expects to see is whichever old default holds some.
            // A folder that cannot be read is assumed to hold data.
            let with_data: Vec<PathBuf> = candidates
                .iter()
                .filter(|c| c.is_dir() && !matches!(holds_no_data(c), Ok(true)))
                .map(|c| (*c).clone())
                .collect();
            match with_data.len() {
                0 => return Err(SkipReason::LegacyFolderMissing(candidates[0].clone())),
                1 => with_data.into_iter().next().unwrap_or_default(),
                _ => return Err(SkipReason::AmbiguousLegacyFolders(with_data)),
            }
        }
    };

    if !legacy.is_dir() {
        return Err(SkipReason::LegacyFolderMissing(legacy));
    }
    match holds_no_data(target) {
        Ok(true) => Ok(legacy),
        Ok(false) | Err(_) => Err(SkipReason::TargetNotEmpty(target.to_path_buf())),
    }
}

fn configured_data_folder(config_file: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(config_file).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    value.get("data_folder")?.as_str().map(PathBuf::from)
}

/// Point every settings file that names `legacy` at `target`, keeping every
/// other field. A failed write restores the files already written.
fn repoint_configs(config_files: &[PathBuf], legacy: &Path, target: &Path) -> Result<usize, String> {
    let mut written: Vec<(&PathBuf, String)> = Vec::new();
    let restore = |written: &[(&PathBuf, String)]| {
        for (file, original) in written {
            let _ = fs::write(file, original);
        }
    };

    for file in config_files {
        let Ok(original) = fs::read_to_string(file) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<Value>(&original) else {
            continue;
        };
        let names_legacy = value
            .get("data_folder")
            .and_then(Value::as_str)
            .is_some_and(|folder| same_path(Path::new(folder), legacy));
        if !names_legacy {
            continue;
        }

        value["data_folder"] = Value::String(target.to_string_lossy().into_owned());
        let written_ok = serde_json::to_string(&value)
            .map_err(|err| err.to_string())
            .and_then(|updated| fs::write(file, updated).map_err(|err| err.to_string()));
        if let Err(err) = written_ok {
            restore(&written);
            return Err(format!("{}: {err}", file.display()));
        }
        written.push((file, original));
    }
    Ok(written.len())
}

/// True when `path` is missing, or holds nothing but empty directories and
/// zero-byte files. That is the shape `jan-cli` leaves behind when it runs
/// before the app has moved anything (`db/__status__.db`, 0 bytes).
fn holds_no_data(path: &Path) -> io::Result<bool> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(err),
    };
    if meta.file_type().is_symlink() {
        return Ok(false);
    }
    if meta.is_file() {
        return Ok(meta.len() == 0);
    }
    for entry in fs::read_dir(path)? {
        if !holds_no_data(&entry?.path())? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Paths as the file system compares them: on Windows without regard to case
/// or separator, and never sensitive to a trailing separator.
fn same_path(a: &Path, b: &Path) -> bool {
    comparable(a) == comparable(b)
}

fn comparable(path: &Path) -> String {
    let mut text = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        text = text.replace('/', "\\").to_lowercase();
    }
    while text.len() > 1 && (text.ends_with('/') || text.ends_with('\\')) {
        text.pop();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{tempdir, TempDir};

    struct Layout {
        root: TempDir,
        /// `<data_dir>/Atomic Chat/data`, the shipped default.
        legacy: PathBuf,
        /// `<data_dir>/Radium Chat/data`, which jan-cli can have created.
        stray: PathBuf,
        /// `<data_dir>/Radium/data`, the new default.
        target: PathBuf,
        current_cfg: PathBuf,
        legacy_cfg: PathBuf,
    }

    impl Layout {
        fn candidates(&self) -> Vec<PathBuf> {
            vec![self.legacy.clone(), self.stray.clone()]
        }
    }

    fn layout() -> Layout {
        let root = tempdir().unwrap();
        let data_dir = root.path().join("Roaming");
        Layout {
            legacy: build_default_data_folder(&data_dir, LEGACY_PRODUCT_NAME),
            stray: build_default_data_folder(&data_dir, "Radium Chat"),
            target: build_default_data_folder(&data_dir, "Radium"),
            current_cfg: data_dir.join("chat.atomic.app").join(CONFIGURATION_FILE_NAME),
            legacy_cfg: data_dir.join("Atomic-Chat").join(CONFIGURATION_FILE_NAME),
            root,
        }
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn settings(path: &Path, data_folder: &Path) {
        let json = serde_json::json!({
            "data_folder": data_folder,
            "autostart_preference": "enabled",
        });
        write(path, &json.to_string());
    }

    fn read_settings(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn moves_the_default_folder_and_repoints_every_settings_file() {
        let l = layout();
        write(&l.legacy.join("threads/t1/thread.json"), r#"{"id":"t1"}"#);
        settings(&l.legacy_cfg, &l.legacy);
        settings(&l.current_cfg, &l.legacy);

        let outcome = migrate(
            &[l.legacy_cfg.clone(), l.current_cfg.clone()],
            &l.candidates(),
            &l.target,
        );

        assert_eq!(
            outcome,
            MigrationOutcome::Moved {
                from: l.legacy.clone(),
                to: l.target.clone(),
                configs_updated: 2,
            }
        );
        assert_eq!(
            fs::read_to_string(l.target.join("threads/t1/thread.json")).unwrap(),
            r#"{"id":"t1"}"#
        );
        assert!(!l.legacy.exists());
        assert!(
            !l.legacy.parent().unwrap().exists(),
            "the emptied Atomic Chat folder is removed"
        );
        for cfg in [&l.legacy_cfg, &l.current_cfg] {
            let saved = read_settings(cfg);
            assert_eq!(saved["data_folder"], l.target.to_string_lossy().as_ref());
            assert_eq!(saved["autostart_preference"], "enabled");
        }
    }

    #[test]
    fn a_second_launch_changes_nothing() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");
        settings(&l.current_cfg, &l.legacy);
        let files = [l.current_cfg.clone()];

        assert!(matches!(
            migrate(&files, &l.candidates(), &l.target),
            MigrationOutcome::Moved { .. }
        ));
        assert_eq!(
            migrate(&files, &l.candidates(), &l.target),
            MigrationOutcome::Skipped(SkipReason::AlreadyMigrated)
        );
        assert!(l.target.join("store.json").is_file());
    }

    #[test]
    fn removes_the_empty_radium_chat_folder_jan_cli_left_behind() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");
        write(&l.stray.join("db/__status__.db"), "");
        settings(&l.current_cfg, &l.legacy);

        assert!(matches!(
            migrate(std::slice::from_ref(&l.current_cfg), &l.candidates(), &l.target),
            MigrationOutcome::Moved { .. }
        ));
        assert!(!l.stray.exists());
        assert!(
            !l.stray.parent().unwrap().exists(),
            "the empty Radium Chat folder is removed"
        );
    }

    #[test]
    fn keeps_a_radium_chat_folder_that_holds_data() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");
        write(&l.stray.join("threads/x/thread.json"), r#"{"id":"x"}"#);
        settings(&l.current_cfg, &l.legacy);

        assert!(matches!(
            migrate(std::slice::from_ref(&l.current_cfg), &l.candidates(), &l.target),
            MigrationOutcome::Moved { .. }
        ));
        assert_eq!(
            fs::read_to_string(l.stray.join("threads/x/thread.json")).unwrap(),
            r#"{"id":"x"}"#
        );
    }

    #[test]
    fn moves_a_radium_chat_folder_when_the_settings_name_it() {
        let l = layout();
        write(&l.stray.join("store.json"), "{}");
        settings(&l.current_cfg, &l.stray);

        assert_eq!(
            migrate(std::slice::from_ref(&l.current_cfg), &l.candidates(), &l.target),
            MigrationOutcome::Moved {
                from: l.stray.clone(),
                to: l.target.clone(),
                configs_updated: 1,
            }
        );
        assert!(l.target.join("store.json").is_file());
    }

    #[test]
    fn replaces_an_empty_folder_already_at_the_new_location() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");
        write(&l.target.join("db/__status__.db"), "");
        settings(&l.current_cfg, &l.legacy);

        assert!(matches!(
            migrate(std::slice::from_ref(&l.current_cfg), &l.candidates(), &l.target),
            MigrationOutcome::Moved { configs_updated: 1, .. }
        ));
        assert!(l.target.join("store.json").is_file());
        assert!(!l.target.join("db").exists());
    }

    #[test]
    fn keeps_both_folders_when_the_new_one_already_holds_data() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");
        write(&l.target.join("threads/x/thread.json"), r#"{"id":"x"}"#);
        settings(&l.current_cfg, &l.legacy);

        assert_eq!(
            migrate(std::slice::from_ref(&l.current_cfg), &l.candidates(), &l.target),
            MigrationOutcome::Skipped(SkipReason::TargetNotEmpty(l.target.clone()))
        );
        assert!(l.legacy.join("store.json").is_file());
        assert_eq!(
            fs::read_to_string(l.target.join("threads/x/thread.json")).unwrap(),
            r#"{"id":"x"}"#
        );
        assert_eq!(
            read_settings(&l.current_cfg)["data_folder"],
            l.legacy.to_string_lossy().as_ref()
        );
    }

    #[test]
    fn never_touches_a_custom_data_folder() {
        let l = layout();
        let custom = l.root.path().join("elsewhere/models");
        write(&custom.join("store.json"), "{}");
        write(&l.legacy.join("store.json"), "{}");
        settings(&l.current_cfg, &custom);

        assert_eq!(
            migrate(std::slice::from_ref(&l.current_cfg), &l.candidates(), &l.target),
            MigrationOutcome::Skipped(SkipReason::CustomDataFolder(custom.clone()))
        );
        assert!(custom.join("store.json").is_file());
        assert!(l.legacy.join("store.json").is_file());
        assert!(!l.target.exists());
    }

    #[test]
    fn follows_the_settings_file_the_app_actually_reads() {
        let l = layout();
        let custom = l.root.path().join("elsewhere/models");
        write(&l.legacy.join("store.json"), "{}");
        // The legacy file is read first and names a custom folder; the stale
        // current file still names the old default and must not trigger a move.
        settings(&l.legacy_cfg, &custom);
        settings(&l.current_cfg, &l.legacy);

        assert_eq!(
            migrate(
                &[l.legacy_cfg.clone(), l.current_cfg.clone()],
                &l.candidates(),
                &l.target
            ),
            MigrationOutcome::Skipped(SkipReason::CustomDataFolder(custom))
        );
        assert!(l.legacy.join("store.json").is_file());
    }

    #[test]
    fn moves_the_default_folder_when_no_settings_file_exists_yet() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");

        assert!(matches!(
            migrate(&[], &l.candidates(), &l.target),
            MigrationOutcome::Moved { configs_updated: 0, .. }
        ));
        assert!(l.target.join("store.json").is_file());
    }

    #[test]
    fn refuses_to_choose_between_two_old_folders_that_both_hold_data() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");
        write(&l.stray.join("store.json"), "{}");

        assert_eq!(
            migrate(&[], &l.candidates(), &l.target),
            MigrationOutcome::Skipped(SkipReason::AmbiguousLegacyFolders(vec![
                l.legacy.clone(),
                l.stray.clone()
            ]))
        );
        assert!(l.legacy.join("store.json").is_file());
        assert!(l.stray.join("store.json").is_file());
        assert!(!l.target.exists());
    }

    #[test]
    fn skips_when_there_is_no_old_folder() {
        let l = layout();
        settings(&l.current_cfg, &l.legacy);

        assert_eq!(
            migrate(std::slice::from_ref(&l.current_cfg), &l.candidates(), &l.target),
            MigrationOutcome::Skipped(SkipReason::LegacyFolderMissing(l.legacy.clone()))
        );
        assert!(!l.target.exists());
    }

    #[test]
    fn does_nothing_when_the_product_name_did_not_change() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");

        assert_eq!(
            migrate(&[], std::slice::from_ref(&l.legacy), &l.legacy),
            MigrationOutcome::Skipped(SkipReason::SameFolder)
        );
        assert!(l.legacy.join("store.json").is_file());
    }

    #[test]
    #[allow(clippy::permissions_set_readonly_false)]
    fn puts_everything_back_when_a_settings_file_cannot_be_written() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");
        settings(&l.legacy_cfg, &l.legacy);
        settings(&l.current_cfg, &l.legacy);
        let mut permissions = fs::metadata(&l.current_cfg).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&l.current_cfg, permissions.clone()).unwrap();
        if fs::OpenOptions::new().write(true).open(&l.current_cfg).is_ok() {
            // Running with privileges that ignore read-only files; nothing to prove.
            return;
        }

        let outcome = migrate(
            &[l.legacy_cfg.clone(), l.current_cfg.clone()],
            &l.candidates(),
            &l.target,
        );
        permissions.set_readonly(false);
        fs::set_permissions(&l.current_cfg, permissions).unwrap();

        assert!(matches!(
            outcome,
            MigrationOutcome::Skipped(SkipReason::ConfigWriteFailed(_))
        ));
        assert!(l.legacy.join("store.json").is_file());
        assert!(!l.target.exists());
        for cfg in [&l.legacy_cfg, &l.current_cfg] {
            assert_eq!(
                read_settings(cfg)["data_folder"],
                l.legacy.to_string_lossy().as_ref()
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn compares_windows_paths_without_regard_to_case_or_separators() {
        let l = layout();
        write(&l.legacy.join("store.json"), "{}");
        let shouting = PathBuf::from(
            l.legacy.to_string_lossy().to_uppercase().replace('\\', "/") + "/",
        );
        settings(&l.current_cfg, &shouting);

        assert!(matches!(
            migrate(std::slice::from_ref(&l.current_cfg), &l.candidates(), &l.target),
            MigrationOutcome::Moved { configs_updated: 1, .. }
        ));
    }
}
