use jan_utils::backend_bundle::install_bundled_backend_archives;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use tempfile::tempdir;
use zip::write::SimpleFileOptions;

fn write_zip(path: &Path, entries: &[(&str, &[u8])]) -> (u64, String) {
    let file = File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    for (name, contents) in entries {
        zip.start_file(*name, SimpleFileOptions::default()).unwrap();
        zip.write_all(contents).unwrap();
    }
    zip.finish().unwrap();
    let bytes = fs::read(path).unwrap();
    (bytes.len() as u64, format!("{:x}", Sha256::digest(&bytes)))
}

fn write_manifest(root: &Path, packages: serde_json::Value) {
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "packages": packages
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn installs_exact_backend_and_companion_without_network() {
    let resources = tempdir().unwrap();
    let installs = tempdir().unwrap();
    let package_dir = resources.path().join("llamacpp-upstream").join("b10431");
    fs::create_dir_all(&package_dir).unwrap();

    let (backend_size, backend_sha) = write_zip(
        &package_dir.join("backend.zip"),
        &[("build/bin/llama-server.exe", b"exe")],
    );
    let (companion_size, companion_sha) = write_zip(
        &package_dir.join("cudart.zip"),
        &[("cuda/bin/cudart64_12.dll", b"dll")],
    );

    write_manifest(
        resources.path(),
        serde_json::json!([
            {
                "provider": "llamacpp-upstream",
                "version": "b10431",
                "backend": "win-cuda-12.4-x64",
                "kind": "backend",
                "asset": "backend.zip",
                "size": backend_size,
                "sha256": backend_sha
            },
            {
                "provider": "llamacpp-upstream",
                "version": "b10431",
                "backend": "cudart-win-cuda-12.4-x64",
                "kind": "companion",
                "companion_for": "win-cuda-12.4-x64",
                "asset": "cudart.zip",
                "size": companion_size,
                "sha256": companion_sha
            }
        ]),
    );

    let result = install_bundled_backend_archives(
        resources.path(),
        "llamacpp-upstream",
        "b10431",
        "win-cuda-12.4-x64",
        installs.path(),
    )
    .unwrap()
    .expect("matching package should install");

    assert_eq!(result.backend_string, "b10431/win-cuda-12.4-x64");
    let installed = installs
        .path()
        .join("b10431")
        .join("win-cuda-12.4-x64")
        .join("build")
        .join("bin");
    assert_eq!(
        fs::read(installed.join("llama-server.exe")).unwrap(),
        b"exe"
    );
    assert_eq!(fs::read(installed.join("cudart64_12.dll")).unwrap(), b"dll");
}

#[test]
fn returns_none_for_an_optional_unbundled_backend() {
    let resources = tempdir().unwrap();
    let installs = tempdir().unwrap();
    write_manifest(resources.path(), serde_json::json!([]));

    let result = install_bundled_backend_archives(
        resources.path(),
        "llamacpp-upstream",
        "b10431",
        "win-vulkan-x64",
        installs.path(),
    )
    .unwrap();

    assert!(result.is_none());
}

#[test]
fn rejects_a_bundled_archive_with_the_wrong_digest() {
    let resources = tempdir().unwrap();
    let installs = tempdir().unwrap();
    let package_dir = resources.path().join("llamacpp").join("b10269-1.5.1");
    fs::create_dir_all(&package_dir).unwrap();
    let (size, _) = write_zip(
        &package_dir.join("backend.zip"),
        &[("build/bin/llama-server.exe", b"exe")],
    );
    write_manifest(
        resources.path(),
        serde_json::json!([{
            "provider": "llamacpp",
            "version": "b10269-1.5.1",
            "backend": "windows-x64-cpu",
            "kind": "backend",
            "asset": "backend.zip",
            "size": size,
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
        }]),
    );

    let error = install_bundled_backend_archives(
        resources.path(),
        "llamacpp",
        "b10269-1.5.1",
        "windows-x64-cpu",
        installs.path(),
    )
    .unwrap_err();

    assert!(error.contains("SHA-256 mismatch"));
    assert!(!installs
        .path()
        .join("b10269-1.5.1")
        .join("windows-x64-cpu")
        .exists());
}

#[test]
fn rejects_zip_path_traversal() {
    let resources = tempdir().unwrap();
    let installs = tempdir().unwrap();
    let package_dir = resources.path().join("llamacpp").join("b10269-1.5.1");
    fs::create_dir_all(&package_dir).unwrap();
    let (size, sha) = write_zip(
        &package_dir.join("backend.zip"),
        &[
            ("../escaped.txt", b"bad"),
            ("build/bin/llama-server.exe", b"exe"),
        ],
    );
    write_manifest(
        resources.path(),
        serde_json::json!([{
            "provider": "llamacpp",
            "version": "b10269-1.5.1",
            "backend": "windows-x64-cpu",
            "kind": "backend",
            "asset": "backend.zip",
            "size": size,
            "sha256": sha
        }]),
    );

    let error = install_bundled_backend_archives(
        resources.path(),
        "llamacpp",
        "b10269-1.5.1",
        "windows-x64-cpu",
        installs.path(),
    )
    .unwrap_err();

    assert!(error.contains("unsafe ZIP entry"));
    assert!(!resources.path().join("escaped.txt").exists());
}
