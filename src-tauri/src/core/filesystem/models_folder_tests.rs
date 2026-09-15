//! The file commands follow the models folder the user chose
//! (core::app::models_folder): the extensions keep spelling model paths under
//! `<data folder>/llamacpp/models`, and the files land in the chosen folder.

use super::commands::*;
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::app::models_folder::TestModelsFolder;
use crate::test_support::TestDataRoot;
use jan_utils::normalize_path;
use std::fs;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tempfile::{tempdir, TempDir};

struct Setup {
    app: tauri::App<MockRuntime>,
    data: std::path::PathBuf,
    chosen: std::path::PathBuf,
    _tmp: TempDir,
}

fn app_with_chosen_models_folder() -> Setup {
    let tmp = tempdir().unwrap();
    let data = tmp.path().join("data");
    let chosen = tmp.path().join("My Models");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&chosen).unwrap();
    let app = mock_builder()
        .manage(TestDataRoot(data.clone()))
        .manage(TestModelsFolder(chosen.clone()))
        .build(mock_context(noop_assets()))
        .unwrap();
    Setup {
        app,
        data,
        chosen,
        _tmp: tmp,
    }
}

fn s(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn the_models_root_the_extensions_ask_for_is_the_chosen_folder() {
    let setup = app_with_chosen_models_folder();
    let handle = setup.app.handle().clone();
    assert_eq!(get_jan_data_folder_path(handle.clone()), setup.data);

    let root = join_path(
        handle.clone(),
        vec![s(&setup.data), "llamacpp".into(), "models".into()],
    )
    .unwrap();
    assert_eq!(root, s(&normalize_path(&setup.chosen)));

    let yml = join_path(
        handle,
        vec![
            s(&setup.data),
            "llamacpp/models/org/qwen".into(),
            "model.yml".into(),
        ],
    )
    .unwrap();
    assert_eq!(
        normalize_path(std::path::Path::new(&yml)),
        normalize_path(&setup.chosen.join("org").join("qwen").join("model.yml"))
    );
}

#[test]
fn other_data_folder_paths_are_left_alone() {
    let setup = app_with_chosen_models_folder();
    let joined = join_path(
        setup.app.handle().clone(),
        vec![s(&setup.data), "llamacpp".into(), "backends".into()],
    )
    .unwrap();
    assert_eq!(
        normalize_path(std::path::Path::new(&joined)),
        normalize_path(&setup.data.join("llamacpp").join("backends"))
    );
}

#[test]
fn a_model_settings_file_is_written_to_and_read_from_the_chosen_folder() {
    let setup = app_with_chosen_models_folder();
    let handle = setup.app.handle().clone();
    fs::create_dir_all(setup.chosen.join("qwen")).unwrap();

    write_yaml(
        handle.clone(),
        serde_json::json!({ "model_path": "llamacpp/models/qwen/model.gguf" }),
        "llamacpp/models/qwen/model.yml",
    )
    .unwrap();

    assert!(setup.chosen.join("qwen/model.yml").exists());
    assert!(!setup.data.join("llamacpp/models/qwen/model.yml").exists());
    let read = read_yaml(handle, "llamacpp/models/qwen/model.yml").unwrap();
    assert_eq!(read["model_path"], "llamacpp/models/qwen/model.gguf");
}

#[test]
fn a_model_in_the_chosen_folder_can_be_listed_found_and_deleted() {
    let setup = app_with_chosen_models_folder();
    let handle = setup.app.handle().clone();
    let model_dir = setup.chosen.join("qwen");
    fs::create_dir_all(&model_dir).unwrap();
    fs::write(model_dir.join("model.gguf"), b"weights").unwrap();

    let via_data = s(&setup.data.join("llamacpp/models/qwen/model.gguf"));
    assert!(exists_sync(handle.clone(), vec![via_data]).unwrap());
    let listed =
        readdir_sync(handle.clone(), vec![s(&setup.data.join("llamacpp/models"))]).unwrap();
    assert_eq!(listed.len(), 1);

    rm(handle, vec![s(&setup.data.join("llamacpp/models/qwen"))]).unwrap();
    assert!(!model_dir.exists());
}

#[test]
fn delete_still_refuses_anything_outside_the_app_folders() {
    let setup = app_with_chosen_models_folder();
    let outside = setup._tmp.path().join("someone-elses-files");
    fs::create_dir_all(&outside).unwrap();

    assert!(rm(setup.app.handle().clone(), vec![s(&outside)]).is_err());
    assert!(outside.exists());
}
