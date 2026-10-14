//! Diagnose tools: inspect the network, change nothing.

use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::parse::{self, Interface, WifiInfo};
use super::platform::{self, Os};
use super::run::{run, CommandOutput, CommandSpec, RunError};
use super::{bounded, is_local_address, validate_host, with_raw};
use crate::core::agent::tools::ToolContext;
use crate::core::agent::types::ToolOutcome;

const INTERFACES_TIMEOUT: Duration = Duration::from_secs(25);
const WIFI_TIMEOUT: Duration = Duration::from_secs(25);
const NEIGHBORS_TIMEOUT: Duration = Duration::from_secs(20);
const DNS_TIMEOUT: Duration = Duration::from_secs(8);
const PORT_TIMEOUT: Duration = Duration::from_millis(1_500);
const MAX_PORTS: usize = 20;

fn unsupported(os: Os, what: &str) -> ToolOutcome {
    ToolOutcome::error(format!("{what} is not available on {}", os.name()))
}

fn run_error(what: &str, error: RunError) -> ToolOutcome {
    match error {
        RunError::Cancelled => ToolOutcome {
            status: crate::core::agent::types::ToolStatus::Cancelled,
            summary: format!("{what} cancelled"),
            details: None,
        },
        other => ToolOutcome::error(format!("{what} failed: {other}")),
    }
}

/// Interfaces plus the raw text they came from.
pub(super) async fn gather_interfaces(
    os: Os,
    cancellation: &CancellationToken,
) -> Result<(Vec<Interface>, String), RunError> {
    let specs = platform::interfaces(os);
    let mut outputs: Vec<CommandOutput> = Vec::with_capacity(specs.len());
    for spec in &specs {
        match run(spec, INTERFACES_TIMEOUT, cancellation).await {
            Ok(output) => outputs.push(output),
            // Optional helpers (resolvectl, networksetup) may be missing.
            Err(RunError::NotFound(_)) if !outputs.is_empty() => {
                outputs.push(CommandOutput::default())
            }
            Err(error) => return Err(error),
        }
    }
    let raw = outputs
        .iter()
        .zip(&specs)
        .map(|(output, spec)| format!("$ {}\n{}", spec.program, output.combined()))
        .collect::<Vec<_>>()
        .join("\n");
    let interfaces = match os {
        Os::Windows => parse::windows_interfaces(&outputs[0].stdout),
        Os::Linux => {
            let mut interfaces = parse::linux_interfaces(&outputs[0].stdout, &outputs[1].stdout);
            let dns = parse::resolvectl_dns(&outputs[2].stdout);
            for interface in &mut interfaces {
                if let Some((_, servers)) = dns.iter().find(|(link, _)| *link == interface.name) {
                    interface.dns_servers = servers.clone();
                }
            }
            interfaces
        }
        Os::Mac => {
            let mut interfaces = parse::macos_ifconfig(&outputs[0].stdout);
            let route = parse::macos_default_route(&outputs[1].stdout);
            let dns = parse::scutil_dns(&outputs[2].stdout);
            for interface in &mut interfaces {
                if let Some((gateway, device)) = &route {
                    if *device == interface.name {
                        interface.gateways = vec![gateway.clone()];
                        interface.dns_servers = dns.clone();
                    }
                }
            }
            interfaces
        }
        Os::Other => Vec::new(),
    };
    Ok((interfaces, raw))
}

fn is_up(interface: &Interface) -> bool {
    let status = interface.status.to_lowercase();
    status == "up" || status == "active" || status == "connected"
}

fn format_interface(interface: &Interface) -> String {
    let mut line = format!(
        "- {} [{}]",
        interface.name,
        if interface.status.is_empty() {
            "unknown"
        } else {
            &interface.status
        }
    );
    if !interface.description.is_empty() {
        line.push_str(&format!(" {}", interface.description));
    }
    if !interface.link_speed.is_empty() {
        line.push_str(&format!(", {}", interface.link_speed));
    }
    if !interface.ipv4.is_empty() {
        line.push_str(&format!("\n  IPv4: {}", interface.ipv4.join(", ")));
    }
    if !interface.gateways.is_empty() {
        line.push_str(&format!(
            "\n  Gateway (router): {}",
            interface.gateways.join(", ")
        ));
    }
    if !interface.dns_servers.is_empty() {
        line.push_str(&format!(
            "\n  DNS servers: {}",
            interface.dns_servers.join(", ")
        ));
    }
    if !interface.dhcp.is_empty() {
        line.push_str(&format!("\n  DHCP: {}", interface.dhcp));
    }
    line
}

pub async fn interfaces(context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    if os == Os::Other {
        return Err(unsupported(os, "Listing network adapters"));
    }
    let (interfaces, raw) = gather_interfaces(os, context.cancellation)
        .await
        .map_err(|error| run_error("Listing network adapters", error))?;
    // Connected adapters first; loopback and virtual noise last.
    let mut ordered = interfaces.clone();
    ordered.sort_by_key(|interface| (!is_up(interface), interface.gateways.is_empty()));
    let report = if ordered.is_empty() {
        with_raw("No network adapters could be read.".into(), &raw)
    } else {
        format!(
            "{} network adapter(s), connected ones first:\n{}",
            ordered.len(),
            ordered
                .iter()
                .map(format_interface)
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    Ok(ToolOutcome {
        status: crate::core::agent::types::ToolStatus::Ok,
        summary: bounded(&report, 4_400),
        details: Some(json!({ "interfaces": interfaces })),
    })
}

pub(super) async fn gather_wifi(
    os: Os,
    cancellation: &CancellationToken,
) -> Result<(Option<WifiInfo>, String), ToolOutcome> {
    let Some(spec) = platform::wifi_status(os) else {
        return Err(unsupported(os, "Reading Wi-Fi status"));
    };
    let output = run(&spec, WIFI_TIMEOUT, cancellation)
        .await
        .map_err(|error| run_error("Reading Wi-Fi status", error))?;
    let parsed = match os {
        Os::Windows => parse::netsh_wlan(&output.stdout),
        Os::Mac => parse::macos_airport(&output.stdout),
        Os::Linux => parse::nmcli_wifi(&output.stdout),
        Os::Other => None,
    };
    Ok((parsed, output.combined()))
}

fn describe_signal(wifi: &WifiInfo) -> String {
    let quality = match (wifi.signal_percent, wifi.rssi_dbm) {
        (Some(percent), _) if percent >= 75 => "excellent",
        (Some(percent), _) if percent >= 50 => "good",
        (Some(percent), _) if percent >= 30 => "weak",
        (Some(_), _) => "very weak",
        (None, Some(rssi)) if rssi >= -55 => "excellent",
        (None, Some(rssi)) if rssi >= -67 => "good",
        (None, Some(rssi)) if rssi >= -75 => "weak",
        (None, Some(_)) => "very weak",
        (None, None) => "unknown",
    };
    let mut parts = Vec::new();
    if let Some(percent) = wifi.signal_percent {
        parts.push(format!("{percent}%"));
    }
    if let Some(rssi) = wifi.rssi_dbm {
        parts.push(format!("{rssi} dBm"));
    }
    if let Some(noise) = wifi.noise_dbm {
        parts.push(format!("noise {noise} dBm"));
    }
    format!("{quality} ({})", parts.join(", "))
}

pub async fn wifi_status(context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let (wifi, raw) = gather_wifi(os, context.cancellation).await?;
    let report = match &wifi {
        None => with_raw("No Wi-Fi information could be read (no Wi-Fi adapter, Wi-Fi off, or the output was not recognised).".into(), &raw),
        Some(wifi) if !wifi.connected => format!(
            "Wi-Fi adapter {} is not connected to a network.",
            wifi.interface
        ),
        Some(wifi) => {
            let mut lines = vec![
                format!("Connected to \"{}\" on {}.", wifi.ssid, wifi.interface),
                format!("Signal: {}", describe_signal(wifi)),
            ];
            if !wifi.band.is_empty() || !wifi.channel.is_empty() {
                lines.push(format!("Band/channel: {} / {}", wifi.band, wifi.channel));
            }
            if !wifi.radio.is_empty() {
                lines.push(format!("Standard: {}", wifi.radio));
            }
            if let (Some(rx), Some(tx)) = (wifi.rx_mbps, wifi.tx_mbps) {
                lines.push(format!("Link rate: {rx} Mbps down / {tx} Mbps up"));
            }
            if !wifi.security.is_empty() {
                lines.push(format!("Security: {}", wifi.security));
            }
            lines.join("\n")
        }
    };
    Ok(ToolOutcome {
        status: crate::core::agent::types::ToolStatus::Ok,
        summary: report,
        details: Some(json!({ "wifi": wifi })),
    })
}

/// Resolve with the operating system's resolver, timed.
async fn system_lookup(name: &str) -> (Result<Vec<IpAddr>, String>, Duration) {
    let started = Instant::now();
    let result = tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((name, 0))).await;
    let elapsed = started.elapsed();
    let addresses = match result {
        Err(_) => Err(format!("no answer within {}s", DNS_TIMEOUT.as_secs())),
        Ok(Err(error)) => Err(error.to_string()),
        Ok(Ok(addresses)) => {
            let mut unique: Vec<IpAddr> = Vec::new();
            for address in addresses.map(|socket| socket.ip()) {
                if !unique.contains(&address) {
                    unique.push(address);
                }
            }
            Ok(unique)
        }
    };
    (addresses, elapsed)
}

pub async fn dns_lookup(
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let name = validate_host(args.get("name").and_then(Value::as_str).unwrap_or_default())
        .map_err(ToolOutcome::error)?;
    let server = match args.get("server").and_then(Value::as_str).map(str::trim) {
        None | Some("") => None,
        Some(server) => Some(
            server
                .parse::<IpAddr>()
                .map_err(|_| ToolOutcome::error("`server` must be an IP address"))?
                .to_string(),
        ),
    };
    let os = Os::current();
    let (addresses, elapsed, raw, via) = match &server {
        None => {
            let (result, elapsed) = system_lookup(&name).await;
            (
                result.map(|list| list.iter().map(IpAddr::to_string).collect::<Vec<_>>()),
                elapsed,
                String::new(),
                "the system resolver".to_owned(),
            )
        }
        Some(server) => {
            let spec = platform::dns_lookup_via(os, &name, server)
                .ok_or_else(|| unsupported(os, "Querying a specific DNS server"))?;
            let started = Instant::now();
            let output = run(
                &spec,
                DNS_TIMEOUT + Duration::from_secs(4),
                context.cancellation,
            )
            .await
            .map_err(|error| run_error("DNS lookup", error))?;
            let elapsed = started.elapsed();
            let found = match os {
                Os::Windows => parse::resolve_dns_name(&output.stdout),
                _ => parse::nslookup(&output.stdout),
            };
            let result = if found.is_empty() {
                Err(output
                    .combined()
                    .lines()
                    .last()
                    .unwrap_or("no answer")
                    .to_owned())
            } else {
                Ok(found)
            };
            (
                result,
                elapsed,
                output.combined(),
                format!("DNS server {server}"),
            )
        }
    };
    let millis = elapsed.as_millis();
    match addresses {
        Ok(addresses) if !addresses.is_empty() => Ok(ToolOutcome {
            status: crate::core::agent::types::ToolStatus::Ok,
            summary: format!(
                "{name} resolves to {} via {via} in {millis} ms{}",
                addresses.join(", "),
                if millis > 300 {
                    " (slow; under 100 ms is typical)"
                } else {
                    ""
                }
            ),
            details: Some(
                json!({ "name": name, "server": server, "addresses": addresses, "ms": millis }),
            ),
        }),
        Ok(_) | Err(_) => {
            let reason = addresses
                .err()
                .unwrap_or_else(|| "no addresses returned".into());
            Err(ToolOutcome {
                status: crate::core::agent::types::ToolStatus::Error,
                summary: with_raw(
                    format!("{name} did not resolve via {via} after {millis} ms: {reason}"),
                    &raw,
                ),
                details: Some(json!({ "name": name, "server": server, "ms": millis })),
            })
        }
    }
}

pub async fn ping(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let host = validate_host(args.get("host").and_then(Value::as_str).unwrap_or_default())
        .map_err(ToolOutcome::error)?;
    let count = args
        .get("count")
        .and_then(Value::as_u64)
        .unwrap_or(4)
        .clamp(1, 10) as u32;
    let os = Os::current();
    let spec = platform::ping(os, &host, count).ok_or_else(|| unsupported(os, "Ping"))?;
    let timeout = Duration::from_secs(u64::from(count) * 2 + 8);
    let output = run(&spec, timeout, context.cancellation)
        .await
        .map_err(|error| run_error("Ping", error))?;
    let stats = match os {
        Os::Windows => Some(parse::windows_ping(&output.stdout, count)),
        _ => parse::unix_ping(&output.stdout),
    };
    let Some(stats) = stats else {
        return Err(ToolOutcome::error(with_raw(
            format!("Could not read ping results for {host}."),
            &output.combined(),
        )));
    };
    let latency = match (stats.min_ms, stats.avg_ms, stats.max_ms) {
        (Some(min), Some(avg), Some(max)) => {
            format!(", latency min/avg/max {min:.0}/{avg:.0}/{max:.0} ms")
        }
        _ => String::new(),
    };
    Ok(ToolOutcome {
        status: crate::core::agent::types::ToolStatus::Ok,
        summary: format!(
            "Ping {host}: {}/{} replies, {:.0}% loss{latency}{}",
            stats.received,
            stats.sent,
            stats.loss_percent,
            if stats.received == 0 {
                ". The host did not answer (it may be down, or block ping)."
            } else {
                ""
            }
        ),
        details: Some(json!({ "host": host, "stats": stats })),
    })
}

pub async fn traceroute(
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let host = validate_host(args.get("host").and_then(Value::as_str).unwrap_or_default())
        .map_err(ToolOutcome::error)?;
    let max_hops = args
        .get("maxHops")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 30) as u32;
    let os = Os::current();
    let spec =
        platform::traceroute(os, &host, max_hops).ok_or_else(|| unsupported(os, "Traceroute"))?;
    let timeout = Duration::from_secs(u64::from(max_hops) * 3 + 10).min(Duration::from_secs(100));
    let output = run(&spec, timeout, context.cancellation)
        .await
        .map_err(|error| run_error("Traceroute", error))?;
    let hops = match os {
        Os::Windows => parse::tracert(&output.stdout),
        _ => parse::traceroute(&output.stdout),
    };
    if hops.is_empty() {
        return Err(ToolOutcome::error(with_raw(
            format!("Could not trace the route to {host}."),
            &output.combined(),
        )));
    }
    let lines = hops
        .iter()
        .map(|hop| match (&hop.address, hop.rtt_ms) {
            (Some(address), Some(rtt)) => format!("{:>2}. {address}  {rtt:.0} ms", hop.hop),
            (Some(address), None) => format!("{:>2}. {address}", hop.hop),
            (None, _) => format!("{:>2}. * (no reply)", hop.hop),
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ToolOutcome {
        status: crate::core::agent::types::ToolStatus::Ok,
        summary: format!("Route to {host} ({} hops):\n{lines}", hops.len()),
        details: Some(json!({ "host": host, "hops": hops })),
    })
}

pub async fn neighbors(context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let spec =
        platform::neighbors(os).ok_or_else(|| unsupported(os, "Listing devices on the network"))?;
    let output = run(&spec, NEIGHBORS_TIMEOUT, context.cancellation)
        .await
        .map_err(|error| run_error("Listing devices on the network", error))?;
    let neighbors = match os {
        Os::Windows => parse::windows_neighbors(&output.stdout),
        Os::Linux => parse::linux_neighbors(&output.stdout),
        _ => parse::arp_an(&output.stdout),
    };
    let report = if neighbors.is_empty() {
        with_raw("No other devices are in this computer's neighbour table. (It only lists devices this computer has talked to recently.)".into(), &output.combined())
    } else {
        format!(
            "{} device(s) this computer has seen on the local network recently:\n{}",
            neighbors.len(),
            neighbors
                .iter()
                .map(|n| format!("- {}  {}  on {} ({})", n.ip, n.mac, n.interface, n.state))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    Ok(ToolOutcome {
        status: crate::core::agent::types::ToolStatus::Ok,
        summary: bounded(&report, 4_400),
        details: Some(json!({ "neighbors": neighbors })),
    })
}

pub async fn port_check(
    args: &Value,
    _context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let host = validate_host(args.get("host").and_then(Value::as_str).unwrap_or_default())
        .map_err(ToolOutcome::error)?;
    let ports = args
        .get("ports")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolOutcome::error("`ports` must be an array of port numbers"))?
        .iter()
        .map(|port| {
            port.as_u64()
                .filter(|port| (1..=65_535).contains(port))
                .map(|port| port as u16)
                .ok_or_else(|| ToolOutcome::error("Ports must be numbers from 1 to 65535"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ports.is_empty() || ports.len() > MAX_PORTS {
        return Err(ToolOutcome::error(format!(
            "Check 1-{MAX_PORTS} ports at a time"
        )));
    }
    let (resolved, _) = system_lookup(&host).await;
    let addresses =
        resolved.map_err(|error| ToolOutcome::error(format!("{host} did not resolve: {error}")))?;
    let Some(address) = addresses.first().copied() else {
        return Err(ToolOutcome::error(format!("{host} did not resolve")));
    };
    if let Some(public) = addresses.iter().find(|address| !is_local_address(address)) {
        return Err(ToolOutcome::denied(
            format!(
                "Port checks are limited to devices on your own network; {host} resolves to the public address {public}."
            ),
            "public-address",
        ));
    }
    let results = join_all(ports.iter().map(|port| async move {
        let target = SocketAddr::new(address, *port);
        let state = match tokio::time::timeout(PORT_TIMEOUT, tokio::net::TcpStream::connect(target))
            .await
        {
            Ok(Ok(_)) => "open",
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => "closed",
            Ok(Err(_)) => "unreachable",
            Err(_) => "no answer (filtered or host down)",
        };
        (*port, state)
    }))
    .await;
    let lines = results
        .iter()
        .map(|(port, state)| format!("- {port}: {state}"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ToolOutcome {
        status: crate::core::agent::types::ToolStatus::Ok,
        summary: format!("TCP ports on {host} ({address}):\n{lines}"),
        details: Some(
            json!({ "host": host, "address": address.to_string(), "ports": results.iter().map(|(port, state)| json!({"port": port, "state": state})).collect::<Vec<_>>() }),
        ),
    })
}

/// One end-to-end check, layer by layer: adapter → router → DNS → internet.
pub async fn connectivity(context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let mut lines = Vec::new();
    let (interfaces, _) = gather_interfaces(os, context.cancellation)
        .await
        .map_err(|error| run_error("Checking connectivity", error))?;
    let active = interfaces
        .iter()
        .find(|interface| is_up(interface) && !interface.gateways.is_empty());
    let Some(active) = active else {
        let verdict = "No connected adapter has a router (default gateway). The computer is not on a network: check that Wi-Fi is on and joined, or the cable is plugged in.";
        return Ok(ToolOutcome::ok(verdict));
    };
    lines.push(format!(
        "1. Adapter: {} is connected with address {}.",
        active.name,
        active.ipv4.join(", ")
    ));
    let gateway = active.gateways[0].clone();
    let gateway_ok = match platform::ping(os, &gateway, 2) {
        Some(spec) => match run(&spec, Duration::from_secs(12), context.cancellation).await {
            Ok(output) => {
                let stats = match os {
                    Os::Windows => Some(parse::windows_ping(&output.stdout, 2)),
                    _ => parse::unix_ping(&output.stdout),
                };
                stats.is_some_and(|stats| stats.received > 0)
            }
            Err(RunError::Cancelled) => {
                return Err(run_error("Checking connectivity", RunError::Cancelled))
            }
            Err(_) => false,
        },
        None => false,
    };
    lines.push(format!(
        "2. Router {gateway}: {}",
        if gateway_ok {
            "answers."
        } else {
            "does NOT answer ping (some routers block ping; check the next steps)."
        }
    ));
    let (dns, dns_time) = system_lookup("example.com").await;
    let dns_ok = dns.as_ref().is_ok_and(|addresses| !addresses.is_empty());
    lines.push(format!(
        "3. DNS: {} ({} ms) using {}.",
        if dns_ok {
            "names resolve"
        } else {
            "names do NOT resolve"
        },
        dns_time.as_millis(),
        if active.dns_servers.is_empty() {
            "unknown servers".to_owned()
        } else {
            active.dns_servers.join(", ")
        }
    ));
    let direct = tcp_reachable("1.1.1.1:443").await;
    lines.push(format!(
        "4. Internet by address (1.1.1.1:443): {}.",
        if direct { "reachable" } else { "NOT reachable" }
    ));
    let verdict = match (gateway_ok, dns_ok, direct) {
        (_, true, true) => "Verdict: the connection works end to end. If something still feels slow, check Wi-Fi signal (net.wifi_status) and latency (net.ping).",
        (_, false, true) => "Verdict: the internet is reachable but DNS is failing. Likely fixes: flush the DNS cache, or switch DNS servers.",
        (true, _, false) => "Verdict: the router answers but the internet does not. The problem is probably the router or the internet provider (restart the router, or check for an outage).",
        (false, _, false) => "Verdict: the router does not answer and the internet is unreachable. Likely a Wi-Fi/cable problem on this computer: reconnect Wi-Fi, renew the IP address, or restart the adapter.",
    };
    lines.push(verdict.to_owned());
    Ok(ToolOutcome {
        status: crate::core::agent::types::ToolStatus::Ok,
        summary: lines.join("\n"),
        details: Some(
            json!({ "adapter": active.name, "gateway": gateway, "gatewayOk": gateway_ok, "dnsOk": dns_ok, "internetOk": direct }),
        ),
    })
}

async fn tcp_reachable(target: &str) -> bool {
    let Ok(address) = target.parse::<SocketAddr>() else {
        return false;
    };
    matches!(
        tokio::time::timeout(
            Duration::from_secs(4),
            tokio::net::TcpStream::connect(address)
        )
        .await,
        Ok(Ok(_))
    )
}

/// A Markdown map of this computer's network setup: what the specialist
/// works from, and what a reviewer checks a proposed fix against.
pub async fn system_map(context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let os = Os::current();
    let os_detail = os_description(os, context.cancellation).await;
    let (interfaces, _) = gather_interfaces(os, context.cancellation)
        .await
        .unwrap_or_default();
    let wifi = gather_wifi(os, context.cancellation)
        .await
        .ok()
        .and_then(|(wifi, _)| wifi);
    let mut map = String::from("# System map\n\n## Computer\n");
    map.push_str(&format!("- OS: {os_detail}\n- Hostname: {}\n", hostname()));
    map.push_str("\n## Network adapters\n");
    let mut connected: Vec<&Interface> = interfaces.iter().filter(|i| is_up(i)).collect();
    connected.sort_by_key(|i| i.gateways.is_empty());
    if connected.is_empty() {
        map.push_str("- None connected\n");
    }
    for interface in &connected {
        map.push_str(&format!(
            "- **{}** ({}): IPv4 {}; gateway {}; DNS {}{}\n",
            interface.name,
            if interface.description.is_empty() {
                interface.status.as_str()
            } else {
                interface.description.as_str()
            },
            or_none(&interface.ipv4),
            or_none(&interface.gateways),
            or_none(&interface.dns_servers),
            if interface.dhcp.is_empty() {
                String::new()
            } else {
                format!("; DHCP {}", interface.dhcp)
            },
        ));
    }
    let others = interfaces.len() - connected.len();
    if others > 0 {
        map.push_str(&format!(
            "- {others} other adapter(s) disconnected or virtual\n"
        ));
    }
    map.push_str("\n## Wi-Fi\n");
    match &wifi {
        Some(wifi) if wifi.connected => map.push_str(&format!(
            "- Connected to \"{}\" on {} — {} on {} channel {}\n",
            wifi.ssid,
            wifi.interface,
            describe_signal(wifi),
            wifi.band,
            wifi.channel
        )),
        Some(wifi) => map.push_str(&format!("- Adapter {} not connected\n", wifi.interface)),
        None => map.push_str("- No Wi-Fi information\n"),
    }
    map.push_str("\n## Fixes available on this OS\n");
    for (tool, available) in fixes_available(os, &interfaces) {
        map.push_str(&format!(
            "- {tool}: {}\n",
            if available { "yes" } else { "not available" }
        ));
    }
    map.push_str(
        "\n## Rules\n- Adapter names for fixes must be one of the adapters listed above, exactly.\n\
         - Prefer the smallest fix that addresses the diagnosed layer (DNS → net.dns_flush/net.set_dns; \
         IP/router → net.dhcp_renew; driver/link → net.adapter_restart; Wi-Fi → net.wifi_reconnect).\n\
         - net.stack_reset is a last resort: high risk, needs a reboot.\n",
    );
    Ok(ToolOutcome {
        status: crate::core::agent::types::ToolStatus::Ok,
        summary: bounded(&map, 4_600),
        details: Some(json!({ "markdown": map, "interfaces": interfaces, "wifi": wifi })),
    })
}

fn or_none(values: &[String]) -> String {
    if values.is_empty() {
        "none".into()
    } else {
        values.join(", ")
    }
}

fn fixes_available(os: Os, interfaces: &[Interface]) -> Vec<(&'static str, bool)> {
    let adapter = interfaces.first().map(|i| i.name.as_str()).unwrap_or("x");
    vec![
        ("net.dns_flush", platform::dns_flush(os).is_some()),
        (
            "net.dhcp_renew",
            platform::dhcp_renew(os, Some(adapter)).is_some(),
        ),
        (
            "net.adapter_restart",
            platform::adapter_restart(os, adapter).is_some(),
        ),
        ("net.set_dns", platform::set_dns(os, adapter, &[]).is_some()),
        (
            "net.wifi_reconnect",
            platform::wifi_reconnect(os, adapter, adapter).is_some(),
        ),
        ("net.stack_reset", platform::stack_reset(os).is_some()),
    ]
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|name| name.trim().to_owned())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

async fn os_description(os: Os, cancellation: &CancellationToken) -> String {
    let spec = match os {
        Os::Windows => CommandSpec::powershell(
            "$o = Get-CimInstance Win32_OperatingSystem; \"$($o.Caption) $($o.Version) $($o.OSArchitecture); PowerShell $($PSVersionTable.PSVersion)\"",
        ),
        Os::Mac => CommandSpec::new("sw_vers", &[]),
        Os::Linux => {
            return std::fs::read_to_string("/etc/os-release")
                .ok()
                .and_then(|text| {
                    text.lines()
                        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
                        .map(|name| name.trim_matches('"').to_owned())
                })
                .unwrap_or_else(|| "Linux".into());
        }
        Os::Other => return os.name().into(),
    };
    match run(&spec, Duration::from_secs(15), cancellation).await {
        Ok(output) if output.success && !output.stdout.trim().is_empty() => output
            .stdout
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        _ => os.name().into(),
    }
}
