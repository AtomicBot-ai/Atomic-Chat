use super::commands::*;
use super::helpers::resolve_path;
use crate::core::app::commands::get_jan_data_folder_path;
use std::fs::{self, File};
use std::io::Write;
use tauri::test::mock_app;

#[test]
fn test_rm() {
    let app = mock_app();
    let path = "test_rm_dir";
    fs::create_dir_all(get_jan_data_folder_path(app.handle().clone()).join(path)).unwrap();
    let args = vec![format!("file://{path}").to_string()];
    let result = rm(app.handle().clone(), args);
    assert!(result.is_ok());
    assert!(!get_jan_data_folder_path(app.handle().clone())
        .join(path)
        .exists());
}

#[test]
fn test_mkdir() {
    let app = mock_app();
    let path = "test_mkdir_dir";
    let args = vec![format!("file://{path}").to_string()];
    let result = mkdir(app.handle().clone(), args);
    assert!(result.is_ok());
    assert!(get_jan_data_folder_path(app.handle().clone())
        .join(path)
        .exists());
    let _ = fs::remove_dir_all(get_jan_data_folder_path(app.handle().clone()).join(path));
}

#[test]
fn test_join_path() {
    let app = mock_app();
    let path = "file://test_dir";
    let args = vec![path.to_string(), "test_file".to_string()];
    let result = join_path(app.handle().clone(), args).unwrap();
    assert_eq!(
        result,
        get_jan_data_folder_path(app.handle().clone())
            .join(format!("test_dir{}test_file", std::path::MAIN_SEPARATOR))
            .to_string_lossy()
            .to_string()
    );
}

#[test]
fn test_exists_sync() {
    let app = mock_app();
    let path = "file://test_exists_sync_file";
    let dir_path = get_jan_data_folder_path(app.handle().clone());
    fs::create_dir_all(&dir_path).unwrap();
    let file_path = dir_path.join("test_exists_sync_file");
    File::create(&file_path).unwrap();
    let args: Vec<String> = vec![path.to_string()];
    let result = exists_sync(app.handle().clone(), args).unwrap();
    assert!(result);
    fs::remove_file(file_path).unwrap();
}

#[test]
fn test_read_file_sync() {
    let app = mock_app();
    let path = "file://test_read_file_sync_file";
    let dir_path = get_jan_data_folder_path(app.handle().clone());
    fs::create_dir_all(&dir_path).unwrap();
    let file_path = dir_path.join("test_read_file_sync_file");
    let mut file = File::create(&file_path).unwrap();
    file.write_all(b"test content").unwrap();
    let args = vec![path.to_string()];
    let result = read_file_sync(app.handle().clone(), args).unwrap();
    assert_eq!(result, "test content".to_string());
    fs::remove_file(file_path).unwrap();
}

#[test]
fn test_readdir_sync() {
    let app = mock_app();
    let dir_path = get_jan_data_folder_path(app.handle().clone()).join("test_readdir_sync_dir");
    fs::create_dir_all(&dir_path).unwrap();
    File::create(dir_path.join("file1.txt")).unwrap();
    File::create(dir_path.join("file2.txt")).unwrap();

    let args = vec![dir_path.to_string_lossy().to_string()];
    let result = readdir_sync(app.handle().clone(), args).unwrap();
    assert_eq!(result.len(), 2);

    let _ = fs::remove_dir_all(dir_path);
}

#[test]
fn test_resolve_path() {
    let app = mock_app();

    // A non-file: path is passed through untouched, including an embedded "file:/"
    #[cfg(unix)]
    {
        let weird = resolve_path(app.handle().clone(), "/tmp/a/file:/b.md");
        assert_eq!(weird, std::path::PathBuf::from("/tmp/a/file:/b.md"));
    }

    #[cfg(windows)]
    {
        let drive = resolve_path(app.handle().clone(), "/C:/nonexistent/test/path.md");
        assert_eq!(
            drive,
            std::path::PathBuf::from(r"C:\nonexistent\test\path.md")
        );
    }
}

/// An app whose data folder is `data` and whose core last named `models` as the managed models
/// root (change `add-tensorrt-llm-windows`, design D6; change `add-vllm-runtime`, design D4): on
/// Windows that root is in the WSL guest, outside the data folder.
fn app_with_core_root(data: &std::path::Path, models: Option<&std::path::Path>) -> tauri::App<tauri::test::MockRuntime> {
    use crate::core::filesystem::model_roots::CoreModelRoot;
    let builder = tauri::test::mock_builder().manage(crate::test_support::TestDataRoot(data.to_path_buf()));
    let builder = match models {
        Some(root) => builder.manage(CoreModelRoot::named(root)),
        None => builder.manage(CoreModelRoot::default()),
    };
    builder
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

#[test]
fn model_yml_is_written_and_read_under_the_root_the_core_names() {
    let data = tempfile::tempdir().unwrap();
    let guest = tempfile::tempdir().unwrap();
    let app = app_with_core_root(data.path(), Some(guest.path()));
    let model = guest.path().join("nvidia").join("Qwen3-8B-FP8");
    fs::create_dir_all(&model).unwrap();
    let yml = model.join("model.yml");

    tauri::async_runtime::block_on(write_yaml(
        app.handle().clone(),
        serde_json::json!({ "repository": "nvidia/Qwen3-8B-FP8" }),
        yml.to_str().unwrap(),
    ))
    .unwrap();
    let read = tauri::async_runtime::block_on(read_yaml(app.handle().clone(), yml.to_str().unwrap())).unwrap();

    assert_eq!(read["repository"], "nvidia/Qwen3-8B-FP8");
}

#[test]
fn model_yml_outside_the_data_folder_and_the_core_root_is_refused() {
    let data = tempfile::tempdir().unwrap();
    let guest = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let app = app_with_core_root(data.path(), Some(guest.path()));
    let stray = elsewhere.path().join("model.yml");
    // `..` out of the core's root is outside it too.
    let escape = guest.path().join("..").join(elsewhere.path().file_name().unwrap()).join("model.yml");

    for path in [&stray, &escape] {
        let written = tauri::async_runtime::block_on(write_yaml(
            app.handle().clone(),
            serde_json::json!({}),
            path.to_str().unwrap(),
        ));
        assert!(written.is_err(), "{} was written", path.display());
    }
    fs::write(&stray, "repository: x\n").unwrap();
    assert!(tauri::async_runtime::block_on(read_yaml(app.handle().clone(), stray.to_str().unwrap())).is_err());
}

#[test]
fn model_yml_under_the_data_folder_needs_no_core_root() {
    // Linux: the core names `<data>/managed-models`, inside the data folder.
    let data = tempfile::tempdir().unwrap();
    let app = app_with_core_root(data.path(), None);
    let models = data.path().join("managed-models").join("m");
    fs::create_dir_all(&models).unwrap();
    let yml = models.join("model.yml");

    tauri::async_runtime::block_on(write_yaml(
        app.handle().clone(),
        serde_json::json!({ "repository": "m" }),
        yml.to_str().unwrap(),
    ))
    .unwrap();
    let read = tauri::async_runtime::block_on(read_yaml(app.handle().clone(), "managed-models/m/model.yml")).unwrap();

    assert_eq!(read["repository"], "m");
}
