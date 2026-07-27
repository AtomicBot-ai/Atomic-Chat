use clap::Parser;
use std::path::Path;
use std::process::ExitCode;

use app_lib::core::agent::eval::{run, GaiaEvalArgs};

fn load_gaia_dotenv() {
    let env_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(".env");
    let Ok(contents) = std::fs::read_to_string(env_path) else {
        return;
    };

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key != "HF_TOKEN" && !key.starts_with("GAIA_") {
            continue;
        }
        if std::env::var(key).is_ok_and(|value| !value.trim().is_empty()) {
            continue;
        }
        let value = raw_value
            .trim()
            .trim_matches(|character| character == '"' || character == '\'');
        std::env::set_var(key, value);
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    load_gaia_dotenv();
    env_logger::init();
    let args = GaiaEvalArgs::parse();
    tokio::select! {
        result = run(args) => {
            if let Err(error) = result {
                eprintln!("GAIA evaluation failed: {error}");
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        signal = tokio::signal::ctrl_c() => {
            if let Err(error) = signal {
                eprintln!("Failed to listen for Ctrl-C: {error}");
                ExitCode::FAILURE
            } else {
                eprintln!("GAIA evaluation interrupted");
                ExitCode::from(130)
            }
        }
    }
}
