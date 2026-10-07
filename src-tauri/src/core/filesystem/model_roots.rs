//! The second place model files may be written besides the data folder: the root of the shared
//! store of the managed engines' models (TensorRT-LLM, vLLM) the core names (change
//! `add-tensorrt-llm-windows`, design D6; one store for every managed engine, change
//! `add-vllm-runtime`, design D4). On Linux it is `<data>/managed-models`, inside the data folder
//! anyway; on Windows it is Atomic Chat's own WSL distribution,
//! `\\wsl.localhost\<distro>\var\lib\atomic-chat\scopes\<key>\managed-models`. One root for every
//! engine, so the checks against it stay one comparison.
//!
//! The root comes from the core, asked here — never from the webview, which only ever names a path
//! for the downloader, `write_yaml` and `read_yaml` to check against it. The last root the core
//! named is kept, so reading each model's `model.yml` is not a core call each.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use jan_utils::{canonicalize_existing_prefix, is_within, normalize_path};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

/// `GET /atomic/v1/managed-models/location` on the control API.
pub const LOCATION_ROUTE: &str = "/managed-models/location";

/// What the core answers: the root, as this machine opens it, and the free space for new models
/// there (null when the core could not measure it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelLocation {
    pub root: PathBuf,
    pub free_bytes: Option<u64>,
}

pub fn parse_location(value: &Value) -> Option<ModelLocation> {
    let root = value.get("root")?.as_str().filter(|root| !root.is_empty())?;
    Some(ModelLocation {
        root: PathBuf::from(root),
        free_bytes: value.get("free_bytes").and_then(Value::as_u64),
    })
}

/// The last root the core named. Managed app state; absent where there is no core (mobile).
#[derive(Debug, Default)]
pub struct CoreModelRoot(Mutex<Option<PathBuf>>);

impl CoreModelRoot {
    pub fn named(root: &Path) -> Self {
        Self(Mutex::new(Some(root.to_path_buf())))
    }

    fn get(&self) -> Option<PathBuf> {
        self.0.lock().ok()?.clone()
    }

    fn set(&self, root: &Path) {
        if let Ok(mut held) = self.0.lock() {
            *held = Some(root.to_path_buf());
        }
    }
}

/// Whether `path` lies inside `root`, both resolved as far as they exist (symlinks, the verbatim
/// `\\?\UNC\` spelling Windows returns for `\\wsl.localhost\…`) and `..` taken out first.
pub fn within(path: &Path, root: &Path) -> bool {
    is_within(
        &canonicalize_existing_prefix(&normalize_path(path)),
        &canonicalize_existing_prefix(&normalize_path(root)),
    )
}

/// Ask the core where the managed engines' models go, now — for the free space, which changes — and
/// remember the root. `None` where the core names none: macOS and Windows on ARM (no provider),
/// Windows before Atomic Chat's distribution is imported, or no core at all.
pub async fn fetch<R: Runtime>(app: &AppHandle<R>) -> Option<ModelLocation> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let client = app.try_state::<crate::core::atomic_core::commands::AtomicCoreClient>()?;
        let answer = match client.call("GET", LOCATION_ROUTE, None).await {
            Ok(answer) => answer,
            Err(error) => {
                log::info!("[model-roots] the core names no managed models root: {error:?}");
                return None;
            }
        };
        let location = parse_location(&answer)?;
        if let Some(held) = app.try_state::<CoreModelRoot>() {
            held.set(&location.root);
        }
        Some(location)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        None
    }
}

/// Whether `path` is under the root the core names: the one it named last, and only when that
/// does not hold it, the one it names now.
pub async fn is_under_core_root<R: Runtime>(app: &AppHandle<R>, path: &Path) -> bool {
    let held = app.try_state::<CoreModelRoot>().and_then(|held| held.get());
    if held.as_deref().is_some_and(|root| within(path, root)) {
        return true;
    }
    fetch(app).await.is_some_and(|location| within(path, &location.root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn asks_the_shared_store_not_an_engine() {
        // Change add-vllm-runtime: the core removed `/models/tensorrt-llm/location`.
        assert_eq!(LOCATION_ROUTE, "/managed-models/location");
    }

    #[test]
    fn reads_the_root_and_the_free_space_the_core_names() {
        assert_eq!(
            parse_location(&json!({ "root": "/data/managed-models", "free_bytes": 42 })),
            Some(ModelLocation { root: PathBuf::from("/data/managed-models"), free_bytes: Some(42) })
        );
        assert_eq!(
            parse_location(&json!({ "root": "/r", "free_bytes": null })).map(|l| l.free_bytes),
            Some(None)
        );
        assert_eq!(parse_location(&json!({ "root": "" })), None);
        assert_eq!(parse_location(&json!({ "code": "MANAGED_ADAPTER_UNAVAILABLE" })), None);
    }

    #[test]
    fn a_path_is_within_the_root_only_once_dot_dots_are_taken_out() {
        let root = tempfile::tempdir().unwrap();
        let models = root.path().join("models");
        std::fs::create_dir_all(models.join("a")).unwrap();

        assert!(within(&models.join("a").join("model.yml"), &models));
        assert!(within(&models.join("b").join("not-yet").join("x.safetensors"), &models));
        assert!(!within(&models.join("..").join("elsewhere"), &models));
        assert!(!within(root.path(), &models));
    }

    #[test]
    fn the_held_root_answers_without_a_core() {
        let root = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .manage(CoreModelRoot::named(root.path()))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        assert!(tauri::async_runtime::block_on(is_under_core_root(
            app.handle(),
            &root.path().join("m").join("model.yml")
        )));
        // Not under it, and no core to ask: refused.
        assert!(!tauri::async_runtime::block_on(is_under_core_root(app.handle(), Path::new("/etc/passwd"))));
    }

    #[cfg(windows)]
    #[test]
    fn a_unc_root_in_the_wsl_distribution_holds_its_models_and_nothing_else() {
        let root = Path::new(r"\\wsl.localhost\AtomicChat\var\lib\atomic-chat\scopes\k1\managed-models");
        assert!(within(&root.join(r"nvidia\Qwen3-8B-FP8\model.yml"), root));
        // The verbatim spelling Windows hands back for the same place.
        assert!(within(
            Path::new(r"\\?\UNC\wsl.localhost\AtomicChat\var\lib\atomic-chat\scopes\k1\managed-models\x"),
            root
        ));
        assert!(!within(Path::new(r"\\wsl.localhost\Ubuntu\var\lib\atomic-chat\scopes\k1\managed-models\x"), root));
        assert!(!within(&root.join(r"..\..\..\..\etc"), root));
    }
}
