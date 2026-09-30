//! The addresses another device on the network can dial, for display only.
//!
//! Host validation does not depend on this list: the proxy trusts the local
//! address of each accepted socket (see `dynamic_hosts`), which stays correct
//! across sleep/wake and network changes. This module only answers "what do I
//! type on my phone?", so it may hide addresses that would work but would
//! confuse (a WSL or Docker bridge) without breaking anybody.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};

/// Interface-name prefixes of adapters another device cannot reach.
/// Matched case-insensitively against the start of the name.
const VIRTUAL_INTERFACE_PREFIXES: &[&str] = &[
    // Windows (sysinfo reports the friendly alias)
    "vethernet",
    "virtualbox",
    "vmware",
    // Linux
    "docker",
    "br-",
    "veth",
    "virbr",
    // macOS
    "bridge",
    "utun",
    "awdl",
    "llw",
];

fn is_virtual_interface(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    VIRTUAL_INTERFACE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// Carrier-grade NAT space, which is where Tailscale hands out addresses. On
/// macOS those live on a `utun` interface, on Windows and Linux on a plainly
/// named one; this keeps a mesh-VPN address visible on all three.
fn is_shared_address_space(address: Ipv4Addr) -> bool {
    let [first, second, ..] = address.octets();
    first == 100 && (64..128).contains(&second)
}

fn is_dialable(address: Ipv4Addr) -> bool {
    !(address.is_loopback()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || address.is_unspecified())
}

/// Pure selection over `(interface name, address)` pairs: what to show, and in
/// which order. The default-route address comes first because it is almost
/// always the one the user means.
pub(crate) fn select_lan_addresses(
    interfaces: &[(String, Ipv4Addr)],
    default_route: Option<Ipv4Addr>,
) -> Vec<String> {
    let mut selected: Vec<Ipv4Addr> = Vec::new();
    let mut push = |address: Ipv4Addr| {
        if is_dialable(address) && !selected.contains(&address) {
            selected.push(address);
        }
    };
    if let Some(address) = default_route {
        push(address);
    }
    for (name, address) in interfaces {
        if is_virtual_interface(name) && !is_shared_address_space(*address) {
            continue;
        }
        push(*address);
    }
    selected.iter().map(Ipv4Addr::to_string).collect()
}

/// The local address the OS would use to reach the internet. `connect` on a UDP
/// socket only fixes the local end; nothing is sent.
fn default_route_address() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(address) => Some(address),
        IpAddr::V6(_) => None,
    }
}

fn interface_addresses() -> Vec<(String, Ipv4Addr)> {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let mut addresses = Vec::new();
    for (name, data) in &networks {
        for network in data.ip_networks() {
            if let IpAddr::V4(address) = network.addr {
                addresses.push((name.clone(), address));
            }
        }
    }
    // `Networks` iterates a hash map; keep the display order stable.
    addresses.sort();
    addresses
}

pub(crate) fn lan_addresses() -> Vec<String> {
    select_lan_addresses(&interface_addresses(), default_route_address())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iface(name: &str, address: [u8; 4]) -> (String, Ipv4Addr) {
        (name.to_string(), Ipv4Addr::from(address))
    }

    #[test]
    fn the_default_route_address_leads_and_is_not_repeated() {
        let interfaces = [iface("en1", [10, 0, 0, 9]), iface("en0", [192, 168, 1, 5])];
        assert_eq!(
            select_lan_addresses(&interfaces, Some(Ipv4Addr::new(192, 168, 1, 5))),
            ["192.168.1.5", "10.0.0.9"]
        );
    }

    #[test]
    fn addresses_nobody_can_dial_are_dropped() {
        let interfaces = [
            iface("lo0", [127, 0, 0, 1]),
            iface("en0", [169, 254, 12, 1]),
            iface("en0", [0, 0, 0, 0]),
            iface("en0", [224, 0, 0, 251]),
            iface("en0", [255, 255, 255, 255]),
        ];
        assert!(select_lan_addresses(&interfaces, None).is_empty());
        // A loopback "default route" (no network at all) is dropped too.
        assert!(select_lan_addresses(&[], Some(Ipv4Addr::LOCALHOST)).is_empty());
    }

    #[test]
    fn virtual_adapters_are_hidden_on_every_os() {
        let interfaces = [
            iface("vEthernet (WSL (Hyper-V firewall))", [172, 22, 0, 1]),
            iface("VirtualBox Host-Only Network", [192, 168, 56, 1]),
            iface("VMware Network Adapter VMnet8", [192, 168, 80, 1]),
            iface("docker0", [172, 17, 0, 1]),
            iface("br-3f1c2ab4", [172, 18, 0, 1]),
            iface("veth9a1b", [172, 19, 0, 1]),
            iface("virbr0", [192, 168, 122, 1]),
            iface("bridge100", [192, 168, 64, 1]),
            iface("utun4", [10, 8, 0, 2]),
            iface("Wi-Fi", [192, 168, 1, 20]),
        ];
        assert_eq!(select_lan_addresses(&interfaces, None), ["192.168.1.20"]);
    }

    #[test]
    fn a_mesh_vpn_address_stays_visible_even_on_a_utun_interface() {
        let interfaces = [
            iface("utun3", [100, 101, 102, 103]),
            iface("utun4", [10, 8, 0, 2]),
        ];
        assert_eq!(select_lan_addresses(&interfaces, None), ["100.101.102.103"]);
        assert!(is_shared_address_space(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_shared_address_space(Ipv4Addr::new(100, 127, 255, 254)));
        assert!(!is_shared_address_space(Ipv4Addr::new(100, 128, 0, 1)));
        assert!(!is_shared_address_space(Ipv4Addr::new(100, 63, 0, 1)));
    }

    #[test]
    fn enumerating_this_machine_never_panics_and_yields_dialable_addresses() {
        for address in lan_addresses() {
            let parsed: Ipv4Addr = address.parse().expect("an IPv4 literal");
            assert!(is_dialable(parsed), "{address} must be dialable");
        }
    }
}
