//! Golden fixtures for `atomic-chat-core`'s Foundation Models runtime (PLAN.md §5.1, stage 5).
//!
//! ```sh
//! cargo test --manifest-path src-tauri/plugins/tauri-plugin-foundation-models/Cargo.toml -- --ignored dump_fixtures
//! ```
//!
//! Writes `<repo>/tests/fixtures/core-contracts/foundation-models-errors/<case>.json` and
//! `index.json`: `FoundationModelsError::from_stderr` for the reasons the Swift server reports and
//! the spellings the classifier looks for.

use super::*;
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

fn git_head(root: &PathBuf) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

#[test]
#[ignore]
fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts/foundation-models-errors");
    fs::create_dir_all(&out).unwrap();
    let commit = git_head(&root);
    let source = "src-tauri/plugins/tauri-plugin-foundation-models/src/error.rs";

    // The first four are the exact lines FoundationModelsServerCommand.swift writes before exit 1.
    let cases: Vec<(&str, &str)> = vec![
        ("swift_device_not_eligible", "[foundation-models] ERROR: Device is not eligible for Apple Intelligence"),
        ("swift_apple_intelligence_not_enabled", "[foundation-models] ERROR: Apple Intelligence is not enabled in System Settings"),
        ("swift_model_downloading", "[foundation-models] ERROR: Foundation model is downloading or not yet ready"),
        ("swift_model_unavailable", "[foundation-models] ERROR: Foundation model is unavailable on this system"),
        ("token_device_not_eligible", "availability: deviceNotEligible"),
        ("token_apple_intelligence_not_enabled", "availability: appleIntelligenceNotEnabled"),
        ("token_model_not_ready", "availability: modelNotReady"),
        ("phrase_model_not_ready", "[foundation-models] ERROR: model not ready"),
        ("case_insensitive", "[FOUNDATION-MODELS] ERROR: DEVICE IS NOT ELIGIBLE"),
        ("generic", "[foundation-models] ERROR: bind failed"),
        ("empty", ""),
    ];
    let mut names = Vec::new();
    for (name, stderr) in cases {
        let error = FoundationModelsError::from_stderr(stderr);
        let doc = json!({
            "name": name,
            "source": { "file": source, "commit": commit, "provider": "foundation-models" },
            "comparator": "error-exact",
            "input": { "stderr": stderr },
            "expected": serde_json::to_value(&error).unwrap(),
        });
        fs::write(
            out.join(format!("{name}.json")),
            serde_json::to_string_pretty(&doc).unwrap() + "\n",
        )
        .unwrap();
        names.push(name);
    }
    let index = json!({
        "source": { "file": source, "commit": commit },
        "comparator": "error-exact",
        "note": "expected = serialised FoundationModelsError::from_stderr(stderr) {code, message, details?}. swift_model_downloading classifies as PROCESS_ERROR in the app because the Swift text says \"not yet ready\", not \"model not ready\"; the port corrects this and asserts the corrected result.",
        "cases": names,
    });
    fs::write(out.join("index.json"), serde_json::to_string_pretty(&index).unwrap() + "\n").unwrap();
    eprintln!("wrote {} Foundation Models error fixtures to {}", names.len(), out.display());
}
