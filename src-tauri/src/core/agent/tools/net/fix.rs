//! Fix tools: change network settings. Each is approval-gated (the user saw
//! its blast radius before it runs), validates its target against the live
//! system, records the state it replaces, retries behind the OS admin prompt
//! when the change needs it, and verifies the result afterwards.

use std::time::Duration;

use serde_json::{json, Value};

use super::diagnose::{gather_interfaces, gather_wifi};
use super::platform::{self, Elevated, FixCommand, Os};
use super::run::{
    elevation_declined, linux_elevated, needs_admin, run, windows_elevated, CommandOutput,
    CommandSpec, RunError,
};
use super::{adapter_arg, blast_radius, bounded, validate_adapter, validate_dns_servers};
use crate::core::agent::tools::ToolContext;
use crate::core::agent::types::{ToolOutcome, ToolStatus};

/// Generous: an admin prompt waits for the user.
const FIX_TIMEOUT: Duration = Duration::from_secs(120);

fn unsupported(os: Os, what: &str) -> ToolOutcome {
    ToolOutcome::error(format!("{what} is not available on {}", os.name()))
}

/// Run a fix, retrying behind the admin prompt when the plain attempt was
/// refused for lack of rights.
async fn apply(
    fix: &FixCommand,
    context: &ToolContext<'_>,
) -> Result<(CommandOutput, bool), ToolOutcome> {
    let first = run(&fix.spec, FIX_TIMEOUT, context.cancellation)
        .await
        .map_err(|error| run_failed(&error))?;
    if first.success || !needs_admin(&first) {
        return Ok((first, false));
    }
    let elevated_spec: CommandSpec = match &fix.elevated {
        Elevated::WindowsScript(script) => {
            let output_file =
                std::env::temp_dir().join(format!("radium-net-{}.txt", uuid::Uuid::new_v4()));
            windows_elevated(script, &output_file.display().to_string())
        }
        Elevated::LinuxPkexec => linux_elevated(&fix.spec),
        Elevated::NotApplicable => return Ok((first, false)),
    };
    let second = run(&elevated_spec, FIX_TIMEOUT, context.cancellation)
        .await
        .map_err(|error| run_failed(&error))?;
    if elevation_declined(&second) {
        return Err(ToolOutcome::denied(
            "This change needs administrator rights and the admin prompt was declined. Nothing was changed.",
            "elevation-declined",
        ));
    }
    Ok((second, true))
}

fn run_failed(error: &RunError) -> ToolOutcome {
    match error {
        RunError::Cancelled => ToolOutcome {
            status: ToolStatus::Cancelled,
            summary: "Cancelled before the change ran".into(),
            details: None,
        },
        other => ToolOutcome::error(format!("The change could not run: {other}")),
    }
}

fn outcome(
    tool: &str,
    args: &Value,
    output: &CommandOutput,
    elevated: bool,
    before: Option<String>,
    after: Option<String>,
) -> Result<ToolOutcome, ToolOutcome> {
    let radius = blast_radius(tool, args);
    let mut lines = Vec::new();
    if output.success {
        lines.push(format!(
            "Done{}.",
            if elevated {
                " (with administrator rights)"
            } else {
                ""
            }
        ));
    } else {
        lines.push("The change failed.".into());
    }
    if let Some(before) = &before {
        lines.push(format!("Before: {before}"));
    }
    if let Some(after) = &after {
        lines.push(format!("After: {after}"));
    }
    if let Some(radius) = &radius {
        lines.push(format!("Undo: {}", radius.undo));
    }
    let raw = output.combined();
    if !raw.trim().is_empty() {
        lines.push(format!("Output:\n{}", bounded(raw.trim(), 1_500)));
    }
    let result = ToolOutcome {
        status: if output.success {
            ToolStatus::Ok
        } else {
            ToolStatus::Error
        },
        summary: lines.join("\n"),
        details: Some(json!({
            "blastRadius": radius,
            "elevated": elevated,
            "before": before,
            "after": after,
            "exitCode": output.exit_code,
        })),
    };
    if output.success {
        Ok(result)
    } else {
        Err(result)
    }
}

async fn adapter_names(os: Os, context: &ToolContext<'_>) -> Result<Vec<String>, ToolOutcome> {
    if os == Os::Mac {
        // macOS DNS/power settings address network *services* ("Wi-Fi"),
        // other fixes address devices ("en0"); accept either.
        let services = run(
            &CommandSpec::new("networksetup", &["-listallnetworkservices"]),
            Duration::from_secs(15),
            context.cancellation,
        )
        .await
        .map(|output| {
            output
                .stdout
                .lines()
                .skip(1)
                .map(|line| line.trim_start_matches('*').trim().to_owned())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
        let (interfaces, _) = gather_interfaces(os, context.cancellation)
            .await
            .map_err(|error| run_failed(&error))?;
        return Ok(services
            .into_iter()
            .chain(interfaces.into_iter().map(|interface| interface.name))
            .collect());
    }
    let (interfaces, _) = gather_interfaces(os, context.cancellation)
        .await
        .map_err(|error| run_failed(&error))?;
    Ok(interfaces
        .into_iter()
        .map(|interface| interface.name)
        .collect())
}

async fn required_adapter(
    args: &Value,
    os: Os,
    context: &ToolContext<'_>,
) -> Result<String, ToolOutcome> {
    let name = adapter_arg(args)
        .ok_or_else(|| ToolOutcome::error("`adapter` is required (see net.interfaces)"))?;
    let known = adapter_names(os, context).await?;
    validate_adapter(&name, &known).map_err(ToolOutcome::error)
}

async fn ipv4_of(adapter: &str, os: Os, context: &ToolContext<'_>) -> Option<String> {
    let (interfaces, _) = gather_interfaces(os, context.cancellation).await.ok()?;
    interfaces
        .iter()
        .find(|interface| interface.name == adapter)
        .map(|interface| {
            if interface.ipv4.is_empty() {
                "no IPv4 address".to_owned()
            } else {
                format!("IPv4 {}", interface.ipv4.join(", "))
            }
        })
}

pub async fn dns_flush(context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let fix = platform::dns_flush(os).ok_or_else(|| unsupported(os, "Flushing the DNS cache"))?;
    let (output, elevated) = apply(&fix, context).await?;
    outcome("net.dns_flush", &json!({}), &output, elevated, None, None)
}

pub async fn dhcp_renew(
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let adapter = match adapter_arg(args) {
        Some(_) => Some(required_adapter(args, os, context).await?),
        None => None,
    };
    let fix = platform::dhcp_renew(os, adapter.as_deref()).ok_or_else(|| {
        if adapter.is_none() && os != Os::Windows {
            ToolOutcome::error(format!(
                "On {} name the `adapter` to renew (see net.interfaces)",
                os.name()
            ))
        } else {
            unsupported(os, "Renewing the IP address")
        }
    })?;
    let before = match &adapter {
        Some(adapter) => ipv4_of(adapter, os, context).await,
        None => None,
    };
    let (output, elevated) = apply(&fix, context).await?;
    let after = match &adapter {
        Some(adapter) => ipv4_of(adapter, os, context).await,
        None => None,
    };
    outcome("net.dhcp_renew", args, &output, elevated, before, after)
}

pub async fn adapter_restart(
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let adapter = required_adapter(args, os, context).await?;
    let fix = platform::adapter_restart(os, &adapter)
        .ok_or_else(|| unsupported(os, "Restarting a network adapter"))?;
    let before = ipv4_of(&adapter, os, context).await;
    let (output, elevated) = apply(&fix, context).await?;
    // Give the link a moment to come back before reading it again.
    tokio::time::sleep(Duration::from_secs(5)).await;
    let after = ipv4_of(&adapter, os, context).await;
    outcome(
        "net.adapter_restart",
        args,
        &output,
        elevated,
        before,
        after,
    )
}

async fn dns_servers_of(adapter: &str, os: Os, context: &ToolContext<'_>) -> Option<String> {
    let (interfaces, _) = gather_interfaces(os, context.cancellation).await.ok()?;
    let interface = interfaces
        .iter()
        .find(|interface| interface.name == adapter)?;
    Some(if interface.dns_servers.is_empty() {
        "DNS servers: none listed (automatic)".to_owned()
    } else {
        format!("DNS servers: {}", interface.dns_servers.join(", "))
    })
}

pub async fn set_dns(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let servers = validate_dns_servers(args.get("servers")).map_err(ToolOutcome::error)?;
    let adapter = required_adapter(args, os, context).await?;
    let fix = platform::set_dns(os, &adapter, &servers)
        .ok_or_else(|| unsupported(os, "Changing DNS servers"))?;
    let before = dns_servers_of(&adapter, os, context).await;
    let (output, elevated) = apply(&fix, context).await?;
    let after = dns_servers_of(&adapter, os, context).await;
    outcome("net.set_dns", args, &output, elevated, before, after)
}

pub async fn wifi_reconnect(
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let (wifi, _) = gather_wifi(os, context.cancellation).await?;
    let wifi = wifi.ok_or_else(|| ToolOutcome::error("No Wi-Fi adapter was found"))?;
    if let Some(requested) = adapter_arg(args) {
        if requested != wifi.interface {
            return Err(ToolOutcome::error(format!(
                "The Wi-Fi adapter is '{}', not '{requested}'",
                wifi.interface
            )));
        }
    }
    let profile = if wifi.profile.is_empty() {
        wifi.ssid.clone()
    } else {
        wifi.profile.clone()
    };
    if os == Os::Windows && profile.is_empty() {
        return Err(ToolOutcome::error(
            "Wi-Fi is not connected to a saved network, so there is nothing to reconnect to",
        ));
    }
    let fix = platform::wifi_reconnect(os, &wifi.interface, &profile)
        .ok_or_else(|| unsupported(os, "Reconnecting Wi-Fi"))?;
    let before = Some(format!(
        "connected to \"{}\": {}",
        wifi.ssid, wifi.connected
    ));
    let (output, elevated) = apply(&fix, context).await?;
    tokio::time::sleep(Duration::from_secs(6)).await;
    let after = gather_wifi(os, context.cancellation)
        .await
        .ok()
        .and_then(|(wifi, _)| wifi)
        .map(|wifi| {
            if wifi.connected {
                format!("connected to \"{}\"", wifi.ssid)
            } else {
                "not connected yet".to_owned()
            }
        });
    outcome("net.wifi_reconnect", args, &output, elevated, before, after)
}

pub async fn stack_reset(context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let fix =
        platform::stack_reset(os).ok_or_else(|| unsupported(os, "Resetting the network stack"))?;
    let (output, elevated) = apply(&fix, context).await?;
    let mut result = outcome("net.stack_reset", &json!({}), &output, elevated, None, None);
    if let Ok(outcome) = &mut result {
        outcome
            .summary
            .push_str("\nRestart the computer to finish the reset.");
    }
    result
}
