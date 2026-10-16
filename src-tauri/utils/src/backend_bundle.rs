use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_EXPANDED_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledBackendInstall {
    pub backend_string: String,
    pub version: String,
    pub backend: String,
}

#[derive(Debug, Deserialize)]
struct BundleManifest {
    schema_version: u32,
    packages: Vec<BundlePackage>,
}

#[derive(Debug, Clone, Deserialize)]
struct BundlePackage {
    provider: String,
    version: String,
    backend: String,
    kind: String,
    companion_for: Option<String>,
    asset: String,
    size: u64,
    sha256: String,
}

fn validate_segment(value: &str, field: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    if value.is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(format!("invalid bundled backend {field}: {value}"));
    }
    Ok(())
}

fn verify_archive(path: &Path, package: &BundlePackage) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("read bundled archive {}: {error}", path.display()))?;
    if metadata.len() != package.size {
        return Err(format!(
            "bundled archive size mismatch for {}: expected {}, got {}",
            package.asset,
            package.size,
            metadata.len()
        ));
    }

    let mut file = File::open(path)
        .map_err(|error| format!("open bundled archive {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("hash bundled archive {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if !actual.eq_ignore_ascii_case(&package.sha256) {
        return Err(format!(
            "bundled archive SHA-256 mismatch for {}: expected {}, got {}",
            package.asset, package.sha256, actual
        ));
    }
    Ok(())
}

fn extract_zip(path: &Path, output: &Path) -> Result<(), String> {
    let file = File::open(path)
        .map_err(|error| format!("open bundled ZIP {}: {error}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("read bundled ZIP {}: {error}", path.display()))?;
    let expanded_size = (0..archive.len()).try_fold(0_u64, |total, index| {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("read bundled ZIP entry: {error}"))?;
        total
            .checked_add(entry.size())
            .filter(|size| *size <= MAX_EXPANDED_ARCHIVE_BYTES)
            .ok_or_else(|| "bundled ZIP expands beyond the 8 GiB safety limit".to_string())
    })?;
    let _ = expanded_size;

    fs::create_dir_all(output)
        .map_err(|error| format!("create bundled extraction directory: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("read bundled ZIP entry: {error}"))?;
        let relative = entry.enclosed_name().ok_or_else(|| {
            format!(
                "unsafe ZIP entry path: {}",
                entry.name().unwrap_or_default()
            )
        })?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!(
                "unsafe ZIP entry type: {}",
                entry.name().unwrap_or_default()
            ));
        }
        let destination = output.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|error| format!("create {}: {error}", destination.display()))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        let mut output_file = File::create(&destination)
            .map_err(|error| format!("create {}: {error}", destination.display()))?;
        std::io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("extract {}: {error}", destination.display()))?;
        output_file
            .flush()
            .map_err(|error| format!("flush {}: {error}", destination.display()))?;
    }
    Ok(())
}

fn find_named_file(root: &Path, name: &str) -> Result<Option<PathBuf>, String> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("read {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| format!("read directory entry: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("read file type: {error}"))?;
            if file_type.is_symlink() {
                return Err(format!(
                    "unsafe symlink in bundled backend: {}",
                    entry.path().display()
                ));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
            {
                return Ok(Some(entry.path()));
            }
        }
    }
    Ok(None)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("create {}: {error}", destination.display()))?;
    for entry in
        fs::read_dir(source).map_err(|error| format!("read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("read directory entry: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read file type: {error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "refusing bundled symlink: {}",
                source_path.display()
            ));
        }
        if file_type.is_dir() {
            copy_tree(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn copy_dlls(source: &Path, destination: &Path) -> Result<usize, String> {
    let mut copied = 0;
    let mut pending = vec![source.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("read {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| format!("read directory entry: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("read file type: {error}"))?;
            if file_type.is_symlink() {
                return Err(format!(
                    "refusing bundled symlink: {}",
                    entry.path().display()
                ));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"))
            {
                fs::copy(entry.path(), destination.join(entry.file_name()))
                    .map_err(|error| format!("copy companion DLL: {error}"))?;
                copied += 1;
            }
        }
    }
    Ok(copied)
}

/// Installs an exact provider/version/backend match from staged application
/// resources. `Ok(None)` means the requested variant is intentionally not
/// bundled and the caller may use its normal optional-download path.
pub fn install_bundled_backend_archives(
    package_root: &Path,
    provider: &str,
    version: &str,
    backend: &str,
    backends_dir: &Path,
) -> Result<Option<BundledBackendInstall>, String> {
    validate_segment(provider, "provider")?;
    validate_segment(version, "version")?;
    validate_segment(backend, "backend")?;

    let manifest_path = package_root.join("manifest.json");
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let manifest: BundleManifest = serde_json::from_slice(
        &fs::read(&manifest_path)
            .map_err(|error| format!("read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("parse {}: {error}", manifest_path.display()))?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "unsupported bundled backend manifest schema {}",
            manifest.schema_version
        ));
    }

    let primary = match manifest.packages.iter().find(|package| {
        package.kind == "backend"
            && package.provider == provider
            && package.version == version
            && package.backend == backend
    }) {
        Some(package) => package.clone(),
        None => return Ok(None),
    };
    validate_segment(&primary.asset, "asset")?;

    let companions: Vec<BundlePackage> = manifest
        .packages
        .iter()
        .filter(|package| {
            package.kind == "companion"
                && package.provider == provider
                && package.version == version
                && package.companion_for.as_deref() == Some(backend)
        })
        .cloned()
        .collect();
    for companion in &companions {
        validate_segment(&companion.asset, "asset")?;
    }

    let target = backends_dir.join(version).join(backend);
    let target_executable = target.join("build").join("bin").join("llama-server.exe");
    if target_executable.is_file() {
        return Ok(Some(BundledBackendInstall {
            backend_string: format!("{version}/{backend}"),
            version: version.to_string(),
            backend: backend.to_string(),
        }));
    }

    let package_dir = package_root.join(provider).join(version);
    let primary_archive = package_dir.join(&primary.asset);
    verify_archive(&primary_archive, &primary)?;
    for companion in &companions {
        verify_archive(&package_dir.join(&companion.asset), companion)?;
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("read system clock: {error}"))?
        .as_nanos();
    let staging = backends_dir
        .join(version)
        .join(format!(".{backend}.bundled-{}-{nonce}", std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("clear stale staging directory: {error}"))?;
    }

    let install_result = (|| -> Result<(), String> {
        let primary_extract = staging.join("primary");
        extract_zip(&primary_archive, &primary_extract)?;
        let executable = find_named_file(&primary_extract, "llama-server.exe")?
            .ok_or_else(|| "bundled backend archive contains no llama-server.exe".to_string())?;
        let source_bin = executable
            .parent()
            .ok_or_else(|| "bundled llama-server.exe has no parent directory".to_string())?;
        let normalized_bin = staging.join("install").join("build").join("bin");
        copy_tree(source_bin, &normalized_bin)?;

        for (index, companion) in companions.iter().enumerate() {
            let companion_extract = staging.join(format!("companion-{index}"));
            extract_zip(&package_dir.join(&companion.asset), &companion_extract)?;
            if copy_dlls(&companion_extract, &normalized_bin)? == 0 {
                return Err(format!(
                    "bundled companion archive {} contains no DLLs",
                    companion.asset
                ));
            }
        }

        let normalized = staging.join("install");
        if !normalized
            .join("build")
            .join("bin")
            .join("llama-server.exe")
            .is_file()
        {
            return Err("bundled backend normalization produced no llama-server.exe".to_string());
        }

        if target.exists() {
            copy_tree(&normalized, &target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("create {}: {error}", parent.display()))?;
            }
            fs::rename(&normalized, &target).map_err(|error| {
                format!(
                    "install bundled backend {} to {}: {error}",
                    normalized.display(),
                    target.display()
                )
            })?;
        }
        Ok(())
    })();

    let cleanup_result = fs::remove_dir_all(&staging);
    install_result?;
    if let Err(error) = cleanup_result {
        if staging.exists() {
            return Err(format!("clean bundled backend staging directory: {error}"));
        }
    }

    Ok(Some(BundledBackendInstall {
        backend_string: format!("{version}/{backend}"),
        version: version.to_string(),
        backend: backend.to_string(),
    }))
}
