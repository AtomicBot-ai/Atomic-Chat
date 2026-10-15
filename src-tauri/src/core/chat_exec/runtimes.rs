//! Which interpreter runs each `run_script` language on this machine.
//!
//! Python is the app's own (a uv-managed CPython, installed on first use), so
//! it is there everywhere. JavaScript and TypeScript use the bundled bun where
//! the build ships it; shell, PowerShell and batch go through the agent's
//! interpreter table (`interpreter_invocation`) so a script runs the same way
//! for a skill and for chat. The rest are whatever the user has on PATH.

use std::{
    collections::HashMap,
    ffi::OsStr,
    path::{Path, PathBuf},
    time::Duration,
};

use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::types::ScriptLanguage;
use crate::core::agent::tools::interpreter_invocation;
use crate::core::process_env::sanitize_tokio_command;

/// The CPython `run_script` uses everywhere. Pinned so a chat's installed
/// packages keep matching the interpreter that loads them.
pub(crate) const MANAGED_PYTHON_VERSION: &str = "3.12";
/// Downloading CPython is a one-off; it is not counted against a call's timeout.
const PYTHON_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The app's own executables: Tauri puts `externalBin` sidecars beside the
/// main executable and bundled resources under `<resource dir>/resources/bin`.
#[derive(Debug, Clone, Default)]
pub(crate) struct BundledBins {
    pub dirs: Vec<PathBuf>,
}

impl BundledBins {
    pub fn find(&self, name: &str) -> Option<PathBuf> {
        let file = executable_name(name);
        self.dirs
            .iter()
            .map(|dir| dir.join(&file))
            // Dev trees carry zero-byte placeholders for sidecars that were not
            // downloaded (bun on most machines); those are not a runtime.
            .find(|path| {
                path.metadata()
                    .is_ok_and(|meta| meta.is_file() && meta.len() > 0)
            })
    }
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) && Path::new(name).extension().is_none() {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// `which`, over an explicit PATH value (the login shell's on macOS/Linux,
/// where a GUI app inherits launchd's minimal one).
pub(crate) fn find_on_path(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let path = path?;
    let candidates: Vec<String> = if cfg!(windows) && Path::new(name).extension().is_none() {
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        pathext
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| format!("{name}{}", ext.to_ascii_lowercase()))
            .collect()
    } else {
        vec![name.to_owned()]
    };
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| candidates.iter().map(move |file| dir.join(file)))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = path.metadata() else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

/// How a language's script file is run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Runtime {
    /// The uv-managed CPython (`ManagedPython`), resolved when first used.
    ManagedPython,
    /// The agent's interpreter table; `bun` is the bundled bun, if any.
    Shared { bun: Option<PathBuf> },
    /// An interpreter found on PATH, run as `program [args] <script>`.
    System { program: PathBuf, args: Vec<String> },
}

impl Runtime {
    /// The folder MXC must let the runtime read, beyond `%SystemRoot%` and the
    /// app's bundled bin folders (always granted). `None` = nothing extra.
    pub fn install_root(&self) -> Option<PathBuf> {
        match self {
            Runtime::System { program, .. } => install_root_of(program),
            Runtime::Shared { .. } | Runtime::ManagedPython => None,
        }
    }
}

/// `C:\Ruby33\bin\ruby.exe` → `C:\Ruby33`; `/usr/local/bin/ruby` → `/usr/local`.
/// A runtime's libraries sit beside its `bin`, so the parent is what it reads.
fn install_root_of(program: &Path) -> Option<PathBuf> {
    let dir = program.parent()?;
    let is_bin = dir
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("bin"));
    let root = if is_bin { dir.parent()? } else { dir };
    // A drive or filesystem root is never granted as a whole.
    root.parent().map(|_| root.to_path_buf())
}

pub(crate) fn script_extension(language: ScriptLanguage) -> &'static str {
    match language {
        ScriptLanguage::Python => "py",
        ScriptLanguage::Javascript => "js",
        ScriptLanguage::Typescript => "ts",
        ScriptLanguage::Shell if cfg!(windows) => "cmd",
        ScriptLanguage::Shell => "sh",
        ScriptLanguage::Powershell => "ps1",
        ScriptLanguage::Ruby => "rb",
        ScriptLanguage::Perl => "pl",
        ScriptLanguage::Php => "php",
        ScriptLanguage::Lua => "lua",
        ScriptLanguage::R => "R",
    }
}

/// What the machine offers, gathered once per session.
pub(crate) struct RuntimeEnv<'a> {
    pub bins: &'a BundledBins,
    /// PATH to look interpreters up on.
    pub path: Option<&'a OsStr>,
}

pub(crate) fn resolve(language: ScriptLanguage, env: &RuntimeEnv<'_>) -> Option<Runtime> {
    let system = |names: &[&str], args: &[&str]| {
        names.iter().find_map(|name| {
            find_on_path(name, env.path).map(|program| Runtime::System {
                program,
                args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            })
        })
    };
    match language {
        ScriptLanguage::Python => env.bins.find("uv").map(|_| Runtime::ManagedPython),
        ScriptLanguage::Javascript | ScriptLanguage::Typescript => {
            if let Some(bun) = env.bins.find("bun") {
                return Some(Runtime::Shared { bun: Some(bun) });
            }
            // Linux ships no bun: take the user's own. Node runs TypeScript
            // only behind flags that vary by version, so it is JS-only here.
            if let Some(bun) = find_on_path("bun", env.path) {
                return Some(Runtime::Shared { bun: Some(bun) });
            }
            if let Some(runtime) = system(&["deno"], &["run", "--allow-all", "--quiet"]) {
                return Some(runtime);
            }
            (language == ScriptLanguage::Javascript)
                .then(|| system(&["node"], &[]))
                .flatten()
        }
        ScriptLanguage::Shell => {
            if cfg!(windows) {
                Some(Runtime::Shared { bun: None })
            } else {
                // The agent's table runs `.sh` with bash.
                find_on_path("bash", env.path).map(|_| Runtime::Shared { bun: None })
            }
        }
        ScriptLanguage::Powershell => {
            if cfg!(windows) {
                Some(Runtime::Shared { bun: None })
            } else {
                find_on_path("pwsh", env.path).map(|_| Runtime::Shared { bun: None })
            }
        }
        ScriptLanguage::Ruby => system(&["ruby"], &[]),
        ScriptLanguage::Perl => system(&["perl"], &[]),
        ScriptLanguage::Php => system(&["php"], &[]),
        ScriptLanguage::Lua => system(&["lua", "luajit"], &[]),
        ScriptLanguage::R => system(&["Rscript"], &[]),
    }
}

pub(crate) fn resolve_all(env: &RuntimeEnv<'_>) -> HashMap<ScriptLanguage, Runtime> {
    ScriptLanguage::ALL
        .into_iter()
        .filter_map(|language| resolve(language, env).map(|runtime| (language, runtime)))
        .collect()
}

/// `program` + arguments that run `script` with `runtime`.
pub(crate) fn invocation(
    runtime: &Runtime,
    script: &Path,
    python: Option<&ManagedPython>,
) -> Result<(String, Vec<String>), String> {
    match runtime {
        Runtime::ManagedPython => {
            let python = python.ok_or("Python is not ready")?;
            Ok((
                python.executable.display().to_string(),
                vec!["-u".into(), script.display().to_string()],
            ))
        }
        Runtime::Shared { bun } => interpreter_invocation(script, Vec::new(), bun.as_deref())
            .map_err(|outcome| outcome.summary),
        Runtime::System { program, args } => Ok((
            program.display().to_string(),
            args.iter()
                .cloned()
                .chain(std::iter::once(script.display().to_string()))
                .collect(),
        )),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedPython {
    pub executable: PathBuf,
    /// `sys.base_prefix`, canonical (uv links installs through junctions on
    /// Windows, and MXC grants a path, not what it points at).
    pub base_prefix: PathBuf,
}

impl ManagedPython {
    /// Folders to put first on PATH so `python` / `pip` in a command are this one.
    pub fn path_dirs(&self) -> Vec<PathBuf> {
        let dir = self
            .executable
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.base_prefix.clone());
        if cfg!(windows) {
            vec![dir.clone(), dir.join("Scripts")]
        } else {
            vec![dir]
        }
    }
}

/// Find the uv-managed CPython, installing it on first use.
pub(crate) async fn ensure_managed_python(
    uv: &Path,
    uv_cache: &Path,
    cancel: &CancellationToken,
) -> Result<ManagedPython, String> {
    let executable = match find_managed_python(uv, uv_cache, cancel).await? {
        Some(path) => path,
        None => {
            run_uv(
                uv,
                uv_cache,
                &["python", "install", MANAGED_PYTHON_VERSION],
                PYTHON_INSTALL_TIMEOUT,
                cancel,
            )
            .await
            .map_err(|error| {
                format!("Could not install Python {MANAGED_PYTHON_VERSION}: {error}")
            })?;
            find_managed_python(uv, uv_cache, cancel)
                .await?
                .ok_or_else(|| {
                    format!("Python {MANAGED_PYTHON_VERSION} is missing after its install")
                })?
        }
    };
    let base_prefix = python_base_prefix(&executable, cancel).await?;
    Ok(ManagedPython {
        executable,
        base_prefix,
    })
}

async fn find_managed_python(
    uv: &Path,
    uv_cache: &Path,
    cancel: &CancellationToken,
) -> Result<Option<PathBuf>, String> {
    match run_uv(
        uv,
        uv_cache,
        &[
            "python",
            "find",
            "--no-project",
            "--python-preference",
            "only-managed",
            MANAGED_PYTHON_VERSION,
        ],
        Duration::from_secs(60),
        cancel,
    )
    .await
    {
        Ok(stdout) => {
            let path = PathBuf::from(stdout.trim());
            Ok(path.is_file().then_some(path))
        }
        Err(UvError::Cancelled) => Err("Cancelled".into()),
        Err(_) => Ok(None),
    }
}

#[derive(Debug)]
enum UvError {
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for UvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UvError::Cancelled => f.write_str("cancelled"),
            UvError::Failed(message) => f.write_str(message),
        }
    }
}

async fn run_uv(
    uv: &Path,
    uv_cache: &Path,
    args: &[&str],
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<String, UvError> {
    let mut command = Command::new(uv);
    command
        .args(args)
        .env("UV_CACHE_DIR", uv_cache)
        .env("UV_NO_PROGRESS", "1")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    sanitize_tokio_command(&mut command);
    hide_console(&mut command);
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err(UvError::Cancelled),
        result = tokio::time::timeout(timeout, command.output()) => result
            .map_err(|_| UvError::Failed(format!("uv timed out after {}s", timeout.as_secs())))?
            .map_err(|error| UvError::Failed(format!("could not run uv: {error}")))?,
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(UvError::Failed(stderr.trim().to_owned()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn python_base_prefix(
    executable: &Path,
    cancel: &CancellationToken,
) -> Result<PathBuf, String> {
    let mut command = Command::new(executable);
    command
        .args(["-c", "import sys; print(sys.base_prefix)"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    sanitize_tokio_command(&mut command);
    hide_console(&mut command);
    let output = tokio::select! {
        _ = cancel.cancelled() => return Err("Cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(30), command.output()) => result
            .map_err(|_| "Python did not start in time".to_owned())?
            .map_err(|error| format!("Could not run Python: {error}"))?,
    };
    if !output.status.success() {
        return Err(format!(
            "Python failed to start: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let prefix = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    Ok(plain_canonical(&prefix))
}

/// `canonicalize` without the `\\?\` prefix Windows adds, which MXC paths and
/// most tools do not take.
pub(crate) fn plain_canonical(path: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    canonical
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::test_support::TestWorkspace;

    fn write_executable(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(executable_name(name));
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn offers_python_wherever_uv_is_bundled_and_nothing_without_it() {
        let bin = TestWorkspace::new();
        let empty = BundledBins {
            dirs: vec![bin.path().to_path_buf()],
        };
        let env = RuntimeEnv {
            bins: &empty,
            path: None,
        };
        assert_eq!(resolve(ScriptLanguage::Python, &env), None);

        write_executable(bin.path(), "uv");
        assert_eq!(
            resolve(ScriptLanguage::Python, &env),
            Some(Runtime::ManagedPython)
        );
    }

    #[test]
    fn a_zero_byte_sidecar_placeholder_is_not_a_runtime() {
        let bin = TestWorkspace::new();
        std::fs::write(bin.path().join(executable_name("bun")), b"").unwrap();
        let bins = BundledBins {
            dirs: vec![bin.path().to_path_buf()],
        };

        assert_eq!(bins.find("bun"), None);
    }

    #[test]
    fn runs_javascript_and_typescript_with_the_bundled_bun() {
        let bin = TestWorkspace::new();
        let bun = write_executable(bin.path(), "bun");
        let bins = BundledBins {
            dirs: vec![bin.path().to_path_buf()],
        };
        let env = RuntimeEnv {
            bins: &bins,
            path: None,
        };

        for language in [ScriptLanguage::Javascript, ScriptLanguage::Typescript] {
            let runtime = resolve(language, &env).unwrap();
            assert_eq!(
                runtime,
                Runtime::Shared {
                    bun: Some(bun.clone())
                }
            );
            let script = bin
                .path()
                .join(format!("run.{}", script_extension(language)));
            let (program, args) = invocation(&runtime, &script, None).unwrap();
            assert_eq!(program, bun.display().to_string());
            assert_eq!(args, vec![script.display().to_string()]);
        }
    }

    #[test]
    fn falls_back_to_node_for_javascript_only() {
        let bins = BundledBins::default();
        let path_dir = TestWorkspace::new();
        let node = write_executable(path_dir.path(), "node");
        let path = std::env::join_paths([path_dir.path()]).unwrap();
        let env = RuntimeEnv {
            bins: &bins,
            path: Some(&path),
        };

        assert_eq!(
            resolve(ScriptLanguage::Javascript, &env),
            Some(Runtime::System {
                program: node,
                args: vec![]
            })
        );
        assert_eq!(resolve(ScriptLanguage::Typescript, &env), None);
    }

    #[test]
    fn leaves_out_languages_whose_interpreter_is_missing() {
        let bins = BundledBins::default();
        let path_dir = TestWorkspace::new();
        write_executable(path_dir.path(), "ruby");
        let path = std::env::join_paths([path_dir.path()]).unwrap();
        let env = RuntimeEnv {
            bins: &bins,
            path: Some(&path),
        };

        let languages = resolve_all(&env);
        assert!(languages.contains_key(&ScriptLanguage::Ruby));
        assert!(!languages.contains_key(&ScriptLanguage::Php));
        assert!(!languages.contains_key(&ScriptLanguage::Python));
    }

    #[test]
    fn runs_a_system_interpreter_on_the_script() {
        let runtime = Runtime::System {
            program: PathBuf::from("/opt/deno/bin/deno"),
            args: vec!["run".into(), "--allow-all".into()],
        };
        let (program, args) = invocation(&runtime, Path::new("/w/run.ts"), None).unwrap();

        assert_eq!(program, "/opt/deno/bin/deno");
        assert_eq!(args, ["run", "--allow-all", "/w/run.ts"]);
        assert_eq!(runtime.install_root(), Some(PathBuf::from("/opt/deno")));
    }

    #[test]
    fn never_grants_a_filesystem_root_as_an_install_root() {
        assert_eq!(install_root_of(Path::new("/bin/ruby")), None);
        assert_eq!(install_root_of(Path::new("/ruby")), None);
        assert_eq!(
            install_root_of(Path::new("/usr/local/bin/ruby")),
            Some(PathBuf::from("/usr/local"))
        );
    }

    #[test]
    fn needs_python_resolved_before_running_a_python_script() {
        assert!(invocation(&Runtime::ManagedPython, Path::new("run.py"), None).is_err());

        let python = ManagedPython {
            executable: PathBuf::from("/py/bin/python3.12"),
            base_prefix: PathBuf::from("/py"),
        };
        let (program, args) = invocation(
            &Runtime::ManagedPython,
            Path::new("/w/run.py"),
            Some(&python),
        )
        .unwrap();
        assert_eq!(program, "/py/bin/python3.12");
        assert_eq!(args, ["-u", "/w/run.py"]);
    }

    #[cfg(unix)]
    #[test]
    fn runs_shell_scripts_through_the_agents_table() {
        let path = std::env::var_os("PATH");
        let bins = BundledBins::default();
        let env = RuntimeEnv {
            bins: &bins,
            path: path.as_deref(),
        };
        let runtime = resolve(ScriptLanguage::Shell, &env).expect("bash on PATH");

        let (program, args) = invocation(&runtime, Path::new("/w/run.sh"), None).unwrap();
        assert_eq!(program, "bash");
        assert_eq!(args, ["/w/run.sh"]);
    }
}
