//! `net.*`: the network specialist's tools.
//!
//! Diagnose tools (`PureRead`) inspect the network and change nothing. Fix
//! tools (`ApprovalGated`) change network settings; every call asks the user
//! first and shows its [`BlastRadius`] — what changes, what drops and for how
//! long, how to undo it, and whether it needs admin rights or a reboot.
//!
//! Commands come from [`platform`], fixed per OS; the model only chooses the
//! tool and its validated arguments. The tools belong to the `network` tool
//! pack and are present only on turns whose assistant enables it.

mod diagnose;
mod fix;
#[cfg(test)]
mod live_tests;
pub(crate) mod parse;
pub(crate) mod platform;
pub(crate) mod review;
pub(crate) mod run;

use std::net::IpAddr;

use serde::Serialize;
use serde_json::Value;

use super::ToolContext;
use crate::core::agent::types::ToolOutcome;

/// The tool pack that turns these tools on.
pub const NETWORK_PACK: &str = "network";

pub const NET_DIAGNOSE_TOOLS: [&str; 9] = [
    "net.system_map",
    "net.interfaces",
    "net.wifi_status",
    "net.connectivity",
    "net.dns_lookup",
    "net.ping",
    "net.traceroute",
    "net.neighbors",
    "net.port_check",
];

pub const NET_FIX_TOOLS: [&str; 6] = [
    "net.dns_flush",
    "net.dhcp_renew",
    "net.adapter_restart",
    "net.set_dns",
    "net.wifi_reconnect",
    "net.stack_reset",
];

pub fn net_tool_names() -> impl Iterator<Item = &'static str> {
    NET_DIAGNOSE_TOOLS.into_iter().chain(NET_FIX_TOOLS)
}

pub async fn execute(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    match tool {
        "net.system_map" => diagnose::system_map(context).await,
        "net.interfaces" => diagnose::interfaces(context).await,
        "net.wifi_status" => diagnose::wifi_status(context).await,
        "net.connectivity" => diagnose::connectivity(context).await,
        "net.dns_lookup" => diagnose::dns_lookup(args, context).await,
        "net.ping" => diagnose::ping(args, context).await,
        "net.traceroute" => diagnose::traceroute(args, context).await,
        "net.neighbors" => diagnose::neighbors(context).await,
        "net.port_check" => diagnose::port_check(args, context).await,
        "net.dns_flush" => fix::dns_flush(context).await,
        "net.dhcp_renew" => fix::dhcp_renew(args, context).await,
        "net.adapter_restart" => fix::adapter_restart(args, context).await,
        "net.set_dns" => fix::set_dns(args, context).await,
        "net.wifi_reconnect" => fix::wifi_reconnect(args, context).await,
        "net.stack_reset" => fix::stack_reset(context).await,
        _ => Err(ToolOutcome::error(format!("Unknown network tool: {tool}"))),
    }
}

/// A second opinion on a network fix, for its approval card. `None` for
/// anything that is not a network fix, or when no model is available.
pub async fn review_for_approval(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Option<review::Review> {
    if !NET_FIX_TOOLS.contains(&tool) {
        return None;
    }
    let client = context.client?;
    let map = match diagnose::system_map(context).await {
        Ok(outcome) | Err(outcome) => outcome.summary,
    };
    Some(review::review_with_map(client, &map, tool, args, context.cancellation).await)
}

// ------------------------------------------------------------ validation ---

/// A host the model may ping/trace/look up: an IP address or a DNS name.
/// A leading `-` would turn it into a command-line option, so it never is one.
pub fn validate_host(host: &str) -> Result<String, String> {
    let host = host.trim();
    if host.parse::<IpAddr>().is_ok() {
        return Ok(host.to_owned());
    }
    let valid = !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    if valid {
        Ok(host.to_owned())
    } else {
        Err(format!("'{host}' is not a valid host name or IP address"))
    }
}

/// DNS servers to set: 1-4 IP addresses, or none for "automatic".
pub fn validate_dns_servers(value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Err("`servers` must be an array of IP addresses ([] for automatic)".into());
    };
    if items.len() > 4 {
        return Err("Set at most 4 DNS servers".into());
    }
    items
        .iter()
        .map(|item| {
            let text = item.as_str().unwrap_or_default().trim();
            text.parse::<IpAddr>()
                .map(|address| address.to_string())
                .map_err(|_| format!("'{text}' is not an IP address"))
        })
        .collect()
}

/// An adapter name must name one of this computer's adapters exactly; that
/// keeps a typo or invented name from ever reaching a command.
pub fn validate_adapter(name: &str, known: &[String]) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') {
        return Err("`adapter` must name a network adapter".into());
    }
    if known.iter().any(|known| known == name) {
        Ok(name.to_owned())
    } else {
        Err(format!(
            "No network adapter is named '{name}'. Adapters on this computer: {}",
            if known.is_empty() {
                "none found".to_owned()
            } else {
                known.join(", ")
            }
        ))
    }
}

/// Port checks are for the user's own devices: every address the host
/// resolves to must be private, loopback or link-local.
pub fn is_local_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique local
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link local
        }
    }
}

// ----------------------------------------------------------- blast radius ---

/// What a fix will do to the computer, shown on the approval card before the
/// user decides and repeated in the result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlastRadius {
    /// One plain sentence: what will happen.
    pub action: String,
    /// What changes on the computer.
    pub changes: String,
    /// What stops working, and for how long.
    pub disruption: String,
    /// Who else is affected (other apps, other adapters, other users).
    pub affects: String,
    /// How to put it back.
    pub undo: String,
    pub needs_admin: bool,
    pub needs_reboot: bool,
    /// "low", "medium" or "high".
    pub risk: &'static str,
}

impl BlastRadius {
    pub fn to_markdown(&self) -> String {
        format!(
            "Action: {}\n- Changes: {}\n- Disruption: {}\n- Affects: {}\n- Undo: {}\n- Admin rights: {}\n- Reboot needed: {}\n- Risk: {}",
            self.action,
            self.changes,
            self.disruption,
            self.affects,
            self.undo,
            if self.needs_admin { "yes" } else { "no" },
            if self.needs_reboot { "yes" } else { "no" },
            self.risk,
        )
    }
}

fn adapter_arg(args: &Value) -> Option<String> {
    args.get("adapter")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// The blast radius of a `net.*` fix call, from its arguments alone (it is
/// rendered before anything runs). `None` for diagnose tools.
pub fn blast_radius(tool: &str, args: &Value) -> Option<BlastRadius> {
    let os = platform::Os::current();
    let adapter = adapter_arg(args);
    let adapter_label = adapter.clone().unwrap_or_else(|| "every adapter".into());
    let windows = os == platform::Os::Windows;
    Some(match tool {
        "net.dns_flush" => BlastRadius {
            action: "Clear this computer's DNS cache.".into(),
            changes: "Forgets cached name-to-address lookups; nothing is configured differently.".into(),
            disruption: "None noticeable. The next visit to each site does one fresh DNS lookup.".into(),
            affects: "All apps on this computer (they re-resolve names on next use).".into(),
            undo: "Nothing to undo; the cache refills by itself.".into(),
            needs_admin: !windows,
            needs_reboot: false,
            risk: "low",
        },
        "net.dhcp_renew" => BlastRadius {
            action: format!("Ask the router for a fresh IP address on {adapter_label}."),
            changes: "The IP address, gateway and DNS servers handed out by the router may change.".into(),
            disruption: format!(
                "{adapter_label} drops off the network for a few seconds; open connections (calls, downloads, remote sessions) may break."
            ),
            affects: "Every app using that connection. Port forwards or reservations tied to the old address may stop matching.".into(),
            undo: "Not reversible as such; renewing again usually returns the same address.".into(),
            needs_admin: true,
            needs_reboot: false,
            risk: "medium",
        },
        "net.adapter_restart" => BlastRadius {
            action: format!("Turn the network adapter {adapter_label} off and back on."),
            changes: "No settings change; the adapter re-initialises its driver and reconnects.".into(),
            disruption: format!(
                "{adapter_label} is offline for roughly 5-20 seconds. If this is how you reach this computer remotely, you will be disconnected."
            ),
            affects: "Every app using that adapter; VPNs may need reconnecting.".into(),
            undo: "Nothing to undo. If it does not come back, restart the adapter again or reboot.".into(),
            needs_admin: true,
            needs_reboot: false,
            risk: "medium",
        },
        "net.set_dns" => {
            let servers = validate_dns_servers(args.get("servers")).unwrap_or_default();
            let target = if servers.is_empty() {
                "automatic (from the router)".to_owned()
            } else {
                servers.join(", ")
            };
            BlastRadius {
                action: format!("Change the DNS servers of {adapter_label} to {target}."),
                changes: format!("{adapter_label} will look up website names using {target}."),
                disruption: "A moment while caches refresh. If a server is wrong or unreachable, websites stop loading by name.".into(),
                affects: "All apps using that adapter. Local names that only your router knows (printers, NAS) may stop resolving with public DNS.".into(),
                undo: "Run net.set_dns again with the previous servers shown in the result, or with [] for automatic.".into(),
                needs_admin: true,
                needs_reboot: false,
                risk: "medium",
            }
        }
        "net.wifi_reconnect" => BlastRadius {
            action: format!("Disconnect from Wi-Fi on {adapter_label} and reconnect."),
            changes: "No settings change; the saved network is rejoined.".into(),
            disruption: "Wi-Fi is down for about 5-15 seconds; calls and downloads over Wi-Fi may drop.".into(),
            affects: "Every app on Wi-Fi.".into(),
            undo: "Nothing to undo. If it does not rejoin, pick the network again from the Wi-Fi menu.".into(),
            needs_admin: false,
            needs_reboot: false,
            risk: "low",
        },
        "net.stack_reset" => BlastRadius {
            action: "Reset Windows' network stack (Winsock and TCP/IP) to factory defaults.".into(),
            changes: "Removes custom TCP/IP settings, static IPs entered by hand, and network software hooks (some VPN or filtering software will need reinstalling).".into(),
            disruption: "Takes effect only after a reboot; until then nothing changes. After the reboot, every adapter is reconfigured from scratch.".into(),
            affects: "The whole computer and every app that uses the network, including VPN and security software.".into(),
            undo: "Cannot be undone automatically. Static settings must be re-entered by hand.".into(),
            needs_admin: true,
            needs_reboot: true,
            risk: "high",
        },
        _ => return None,
    })
}

// --------------------------------------------------------------- output ---

/// Leave room in the 4,800-char observation for the formatted report.
const RAW_OUTPUT_CHARS: usize = 2_400;

pub(crate) fn bounded(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push_str("\n… [truncated]");
    out
}

pub(crate) fn with_raw(report: String, raw: &str) -> String {
    if raw.trim().is_empty() {
        report
    } else {
        format!(
            "{report}\n\nRaw output:\n{}",
            bounded(raw.trim(), RAW_OUTPUT_CHARS)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_names_or_addresses_never_options() {
        assert_eq!(validate_host(" example.com ").unwrap(), "example.com");
        assert!(validate_host("192.0.2.1").is_ok());
        assert!(validate_host("2001:db8::1").is_ok());
        assert!(validate_host("-c100").is_err());
        assert!(validate_host("example.com; rm -rf /").is_err());
        assert!(validate_host("a..b").is_err());
        assert!(validate_host("").is_err());
    }

    #[test]
    fn dns_servers_must_be_addresses() {
        let servers = validate_dns_servers(Some(&serde_json::json!(["1.1.1.1", " 8.8.8.8 "])));
        assert_eq!(servers.unwrap(), ["1.1.1.1", "8.8.8.8"]);
        assert!(validate_dns_servers(Some(&serde_json::json!([])))
            .unwrap()
            .is_empty());
        assert!(validate_dns_servers(Some(&serde_json::json!(["dns.google"]))).is_err());
        assert!(validate_dns_servers(Some(&serde_json::json!(vec!["1.1.1.1"; 5]))).is_err());
        assert!(validate_dns_servers(None).is_err());
    }

    #[test]
    fn adapters_must_exist_on_this_computer() {
        let known = vec!["Wi-Fi".to_owned(), "Ethernet".to_owned()];
        assert_eq!(validate_adapter("Wi-Fi", &known).unwrap(), "Wi-Fi");
        let error = validate_adapter("WiFi", &known).unwrap_err();
        assert!(error.contains("Wi-Fi, Ethernet"));
        assert!(validate_adapter("-Name", &known).is_err());
    }

    #[test]
    fn port_checks_stay_on_local_addresses() {
        for local in [
            "192.168.1.10",
            "10.0.0.2",
            "172.16.5.4",
            "127.0.0.1",
            "169.254.1.1",
            "fe80::1",
            "fd00::5",
            "::1",
        ] {
            assert!(is_local_address(&local.parse().unwrap()), "{local}");
        }
        for public in ["1.1.1.1", "8.8.8.8", "2001:db8::1"] {
            assert!(!is_local_address(&public.parse().unwrap()), "{public}");
        }
    }

    #[test]
    fn every_fix_has_a_blast_radius_and_no_diagnosis_does() {
        for tool in NET_FIX_TOOLS {
            let radius = blast_radius(
                tool,
                &serde_json::json!({"adapter": "Wi-Fi", "servers": ["1.1.1.1"]}),
            )
            .unwrap_or_else(|| panic!("{tool} lacks a blast radius"));
            assert!(!radius.action.is_empty() && !radius.undo.is_empty());
        }
        for tool in NET_DIAGNOSE_TOOLS {
            assert!(
                blast_radius(tool, &serde_json::json!({})).is_none(),
                "{tool}"
            );
        }
    }

    #[test]
    fn the_stack_reset_is_flagged_high_risk_and_reboot_bound() {
        let radius = blast_radius("net.stack_reset", &serde_json::json!({})).unwrap();
        assert_eq!(radius.risk, "high");
        assert!(radius.needs_reboot && radius.needs_admin);
        let markdown = radius.to_markdown();
        assert!(markdown.contains("Reboot needed: yes"));
    }

    #[test]
    fn set_dns_names_the_target_servers_or_automatic() {
        let custom = blast_radius(
            "net.set_dns",
            &serde_json::json!({"adapter": "Wi-Fi", "servers": ["1.1.1.1", "1.0.0.1"]}),
        )
        .unwrap();
        assert!(custom.action.contains("1.1.1.1, 1.0.0.1"));
        let automatic = blast_radius(
            "net.set_dns",
            &serde_json::json!({"adapter": "Wi-Fi", "servers": []}),
        )
        .unwrap();
        assert!(automatic.action.contains("automatic"));
    }
}
