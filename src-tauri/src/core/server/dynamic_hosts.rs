//! Hosts the Local API Server trusts without the user typing them into
//! Trusted Hosts.
//!
//! `is_valid_host` rejects any `Host` header that is not loopback or listed in
//! the configured trusted hosts. That is the DNS-rebinding guard, and it stays
//! byte-for-byte as it was. Two callers, though, arrive with a `Host` nobody
//! could have typed in advance:
//!
//! * a Cloudflare quick tunnel, whose `<words>.trycloudflare.com` name is only
//!   known once `cloudflared` has printed it, and is new on every start;
//! * a LAN client dialling this machine's own address, which changes with the
//!   network (sleep/wake, Wi-Fi switch, DHCP lease).
//!
//! Neither weakens the guard. A rebinding attack puts the *attacker's* domain
//! in `Host`; it cannot make the header equal the tunnel's real public name or
//! the literal address of the socket the request arrived on.
//!
//! The proxy appends [`DynamicTrustedHosts::group_for`] as one more group of
//! `ProxyConfig::trusted_hosts` per request, so every existing call site that
//! reads `&config.trusted_hosts` picks it up unchanged.

use std::net::IpAddr;
use std::sync::{Arc, RwLock};

/// Shared between the running proxy and the remote-access manager.
///
/// Not cfg-gated: the proxy runs on mobile too and `proxy::start_server` has
/// one signature for every platform. On mobile nothing ever sets a tunnel
/// host, so only the socket-address half is live there.
#[derive(Clone, Default)]
pub struct DynamicTrustedHosts {
    tunnel_host: Arc<RwLock<Option<String>>>,
}

impl DynamicTrustedHosts {
    /// Trust `host` (a bare hostname, no scheme, port or path) until cleared.
    pub fn set_tunnel_host(&self, host: &str) {
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        let value = (!host.is_empty()).then_some(host);
        if let Ok(mut guard) = self.tunnel_host.write() {
            *guard = value;
        }
    }

    pub fn clear_tunnel_host(&self) {
        if let Ok(mut guard) = self.tunnel_host.write() {
            *guard = None;
        }
    }

    pub fn tunnel_host(&self) -> Option<String> {
        self.tunnel_host.read().ok().and_then(|guard| guard.clone())
    }

    /// The extra trusted-hosts group for one request.
    ///
    /// `local_ip` is the local address of the accepted socket. It is trusted
    /// only when it says something a loopback bind could not: an unspecified
    /// or loopback address adds nothing (`is_valid_host` already allows
    /// loopback), so a server bound to `127.0.0.1` gains no new names.
    pub fn group_for(&self, local_ip: Option<IpAddr>) -> Vec<String> {
        let mut group = Vec::with_capacity(2);
        if let Some(host) = self.tunnel_host() {
            group.push(host);
        }
        if let Some(ip) = local_ip.map(unmap_ipv4) {
            if !ip.is_loopback() && !ip.is_unspecified() {
                group.push(match ip {
                    IpAddr::V4(v4) => v4.to_string(),
                    // `is_valid_host` strips the port of a bracketed literal
                    // only when the trusted entry is bracketed too.
                    IpAddr::V6(v6) => format!("[{v6}]"),
                });
            }
        }
        group
    }
}

/// A dual-stack listener reports IPv4 peers as `::ffff:a.b.c.d`, but the
/// client wrote plain `a.b.c.d` in its `Host` header.
fn unmap_ipv4(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jan_utils::is_valid_host;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn trusted(hosts: &DynamicTrustedHosts, local_ip: Option<IpAddr>) -> Vec<Vec<String>> {
        vec![Vec::new(), hosts.group_for(local_ip)]
    }

    #[test]
    fn nothing_is_trusted_until_something_is_known() {
        let hosts = DynamicTrustedHosts::default();
        assert!(hosts.group_for(None).is_empty());
        assert!(hosts
            .group_for(Some(IpAddr::V4(Ipv4Addr::LOCALHOST)))
            .is_empty());
        assert!(hosts
            .group_for(Some(IpAddr::V4(Ipv4Addr::UNSPECIFIED)))
            .is_empty());
    }

    #[test]
    fn the_tunnel_name_passes_host_validation_only_while_it_is_set() {
        let hosts = DynamicTrustedHosts::default();
        let header = "calm-river-demo.trycloudflare.com";
        assert!(!is_valid_host(header, &trusted(&hosts, None)));

        hosts.set_tunnel_host("Calm-River-Demo.TryCloudflare.com");
        assert_eq!(hosts.tunnel_host().as_deref(), Some(header));
        assert!(is_valid_host(header, &trusted(&hosts, None)));
        // A different quick-tunnel name is still a stranger.
        assert!(!is_valid_host(
            "other-name.trycloudflare.com",
            &trusted(&hosts, None)
        ));

        hosts.clear_tunnel_host();
        assert!(!is_valid_host(header, &trusted(&hosts, None)));
    }

    #[test]
    fn a_lan_client_is_trusted_for_the_address_it_actually_reached() {
        let hosts = DynamicTrustedHosts::default();
        let local = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5));
        let group = trusted(&hosts, Some(local));
        assert!(is_valid_host("192.168.1.5:1337", &group));
        assert!(is_valid_host("192.168.1.5", &group));
        // Another address of the same network is not this socket's address.
        assert!(!is_valid_host("192.168.1.6:1337", &group));
        // The rebinding shape: attacker domain resolving to the LAN address.
        assert!(!is_valid_host("evil.example:1337", &group));
    }

    #[test]
    fn ipv4_mapped_and_ipv6_socket_addresses_match_the_header_spelling() {
        let hosts = DynamicTrustedHosts::default();
        let mapped = IpAddr::V6(Ipv4Addr::new(10, 0, 0, 7).to_ipv6_mapped());
        assert!(is_valid_host(
            "10.0.0.7:1337",
            &trusted(&hosts, Some(mapped))
        ));

        let v6 = IpAddr::V6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 0x10));
        assert!(is_valid_host("[fd00::10]:1337", &trusted(&hosts, Some(v6))));
    }

    #[test]
    fn a_blank_tunnel_host_clears_instead_of_trusting_the_empty_string() {
        let hosts = DynamicTrustedHosts::default();
        hosts.set_tunnel_host("x.trycloudflare.com");
        hosts.set_tunnel_host("   ");
        assert_eq!(hosts.tunnel_host(), None);
        assert!(hosts.group_for(None).is_empty());
    }
}
