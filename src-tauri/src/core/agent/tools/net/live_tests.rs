//! Live checks against the real machine's network commands. Ignored by
//! default (they depend on the host's network); run with
//! `cargo test ... core::agent::tools::net::live_tests -- --ignored --nocapture`.
//! Diagnose commands only: nothing here changes a setting.

use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::diagnose::{gather_interfaces, gather_wifi};
use super::parse;
use super::platform::{self, Os};
use super::run::run;

#[tokio::test]
#[ignore = "touches the host network"]
async fn live_interfaces_parse_on_this_machine() {
    let os = Os::current();
    let (interfaces, raw) = gather_interfaces(os, &CancellationToken::new())
        .await
        .unwrap();
    println!("{} interface(s)", interfaces.len());
    for interface in &interfaces {
        println!(
            "- {} [{}] ipv4={} gw={} dns={}",
            interface.name,
            interface.status,
            interface.ipv4.len(),
            interface.gateways.len(),
            interface.dns_servers.len()
        );
    }
    assert!(!interfaces.is_empty(), "no interfaces parsed; raw:\n{raw}");
}

#[tokio::test]
#[ignore = "touches the host network"]
async fn live_wifi_status_parses_on_this_machine() {
    let os = Os::current();
    match gather_wifi(os, &CancellationToken::new()).await {
        Ok((Some(wifi), _)) => println!(
            "wifi connected={} signal={:?} rssi={:?} band={} channel={}",
            wifi.connected, wifi.signal_percent, wifi.rssi_dbm, wifi.band, wifi.channel
        ),
        Ok((None, raw)) => println!("no wifi parsed; raw:\n{raw}"),
        Err(error) => println!("wifi unavailable: {}", error.summary),
    }
}

#[tokio::test]
#[ignore = "touches the host network"]
async fn live_ping_and_neighbors_parse_on_this_machine() {
    let os = Os::current();
    let cancellation = CancellationToken::new();
    let ping = platform::ping(os, "1.1.1.1", 2).unwrap();
    let output = run(&ping, Duration::from_secs(20), &cancellation)
        .await
        .unwrap();
    let stats = match os {
        Os::Windows => Some(parse::windows_ping(&output.stdout, 2)),
        _ => parse::unix_ping(&output.stdout),
    };
    println!("ping stats: {stats:?}");
    assert!(stats.is_some(), "ping not parsed:\n{}", output.combined());

    let neighbors = platform::neighbors(os).unwrap();
    let output = run(&neighbors, Duration::from_secs(20), &cancellation)
        .await
        .unwrap();
    let parsed = match os {
        Os::Windows => parse::windows_neighbors(&output.stdout),
        Os::Linux => parse::linux_neighbors(&output.stdout),
        _ => parse::arp_an(&output.stdout),
    };
    println!("{} neighbour(s)", parsed.len());
}

#[tokio::test]
#[ignore = "touches the host network"]
async fn live_dns_lookup_via_a_server_parses_on_this_machine() {
    let os = Os::current();
    let spec = platform::dns_lookup_via(os, "example.com", "1.1.1.1").unwrap();
    let output = run(&spec, Duration::from_secs(15), &CancellationToken::new())
        .await
        .unwrap();
    let addresses = match os {
        Os::Windows => parse::resolve_dns_name(&output.stdout),
        _ => parse::nslookup(&output.stdout),
    };
    println!("example.com via 1.1.1.1 -> {addresses:?}");
    assert!(!addresses.is_empty(), "not parsed:\n{}", output.combined());
}

#[tokio::test]
#[ignore = "touches the host network"]
async fn live_traceroute_parses_on_this_machine() {
    let os = Os::current();
    let spec = platform::traceroute(os, "1.1.1.1", 4).unwrap();
    let output = run(&spec, Duration::from_secs(40), &CancellationToken::new())
        .await
        .unwrap();
    let hops = match os {
        Os::Windows => parse::tracert(&output.stdout),
        _ => parse::traceroute(&output.stdout),
    };
    assert!(!hops.is_empty(), "not parsed:\n{}", output.combined());
}
