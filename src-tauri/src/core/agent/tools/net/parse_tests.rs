//! Fixtures are hand-written in each platform's real output format, with
//! documentation addresses (192.0.2.0/24, 198.51.100.0/24) and invented names.

use super::*;

#[test]
fn windows_interfaces_accept_powershells_collapsed_arrays() {
    let json = r#"[
      {"alias":"Wi-Fi","description":"Example WiFi 6E","status":"Up","mac":"AA-BB-CC-DD-EE-01",
       "linkSpeed":"1.2 Gbps","ipv4":"192.0.2.20","ipv6":["fe80::1","2001:db8::20"],
       "gateway":"192.0.2.1","dns":["192.0.2.1","198.51.100.53"],"dhcp":"Enabled"},
      {"alias":"Ethernet","description":"Example GbE","status":"Disconnected","mac":"AA-BB-CC-DD-EE-02",
       "linkSpeed":"0 bps","ipv4":{},"ipv6":null,"gateway":[],"dns":{},"dhcp":"Enabled"}
    ]"#;
    let interfaces = windows_interfaces(json);
    assert_eq!(interfaces.len(), 2);
    assert_eq!(interfaces[0].name, "Wi-Fi");
    assert_eq!(interfaces[0].ipv4, ["192.0.2.20"]);
    assert_eq!(interfaces[0].ipv6.len(), 2);
    assert_eq!(interfaces[0].gateways, ["192.0.2.1"]);
    assert_eq!(interfaces[0].dns_servers, ["192.0.2.1", "198.51.100.53"]);
    assert!(interfaces[1].ipv4.is_empty());
    assert!(interfaces[1].dns_servers.is_empty());
    // A single interface arrives as a bare object.
    let single = r#"{"alias":"Wi-Fi","ipv4":"192.0.2.20"}"#;
    assert_eq!(windows_interfaces(single).len(), 1);
    assert!(windows_interfaces("not json").is_empty());
}

#[test]
fn linux_interfaces_join_addresses_and_default_routes() {
    let addr = r#"[
      {"ifname":"lo","operstate":"UNKNOWN","address":"00:00:00:00:00:00",
       "addr_info":[{"family":"inet","local":"127.0.0.1"}]},
      {"ifname":"wlp3s0","operstate":"UP","address":"aa:bb:cc:dd:ee:01",
       "addr_info":[{"family":"inet","local":"192.0.2.20"},{"family":"inet6","local":"fe80::1"}]}
    ]"#;
    let route = r#"[{"dst":"default","gateway":"192.0.2.1","dev":"wlp3s0"},
                    {"dst":"192.0.2.0/24","dev":"wlp3s0"}]"#;
    let interfaces = linux_interfaces(addr, route);
    let wifi = interfaces.iter().find(|i| i.name == "wlp3s0").unwrap();
    assert_eq!(wifi.status, "UP");
    assert_eq!(wifi.ipv4, ["192.0.2.20"]);
    assert_eq!(wifi.gateways, ["192.0.2.1"]);
    let dns =
        resolvectl_dns("Global:\nLink 2 (wlp3s0): 192.0.2.1 198.51.100.53\nLink 3 (docker0):\n");
    assert_eq!(
        dns[0],
        (
            "wlp3s0".to_owned(),
            vec!["192.0.2.1".to_owned(), "198.51.100.53".to_owned()]
        )
    );
}

#[test]
fn macos_ifconfig_route_and_scutil() {
    let ifconfig = "lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384\n\tinet 127.0.0.1 netmask 0xff000000\n\
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n\tether aa:bb:cc:dd:ee:01\n\
\tinet6 fe80::1%en0 prefixlen 64 secured scopeid 0x6\n\tinet 192.0.2.20 netmask 0xffffff00 broadcast 192.0.2.255\n\tstatus: active\n";
    let interfaces = macos_ifconfig(ifconfig);
    let en0 = interfaces.iter().find(|i| i.name == "en0").unwrap();
    assert_eq!(en0.ipv4, ["192.0.2.20"]);
    assert_eq!(en0.ipv6, ["fe80::1"]);
    assert_eq!(en0.mac, "aa:bb:cc:dd:ee:01");
    assert_eq!(en0.status, "active");
    let route =
        "   route to: default\ndestination: default\n    gateway: 192.0.2.1\n  interface: en0\n";
    assert_eq!(
        macos_default_route(route),
        Some(("192.0.2.1".into(), "en0".into()))
    );
    let scutil = "resolver #1\n  nameserver[0] : 192.0.2.1\n  nameserver[1] : 198.51.100.53\nresolver #2\n  nameserver[0] : 192.0.2.1\n";
    assert_eq!(scutil_dns(scutil), ["192.0.2.1", "198.51.100.53"]);
}

#[test]
fn netsh_wlan_reads_signal_band_and_profile() {
    let text = "There is 1 interface on the system:\n\n    Name                   : Wi-Fi\n    Description            : Example WiFi\n\
    State                  : connected\n    SSID                   : ExampleNet\n    Band                   : 5 GHz\n\
    Channel                : 44\n    Radio type             : 802.11ax\n    Authentication         : WPA3-Personal\n\
    Receive rate (Mbps)    : 1201\n    Transmit rate (Mbps)   : 960\n    Signal                 : 90% \n\
    Rssi                   : -37\n    Profile                : ExampleNet \n";
    let wifi = netsh_wlan(text).unwrap();
    assert!(wifi.connected);
    assert_eq!(wifi.ssid, "ExampleNet");
    assert_eq!(wifi.signal_percent, Some(90));
    assert_eq!(wifi.rssi_dbm, Some(-37));
    assert_eq!(wifi.band, "5 GHz");
    assert_eq!(wifi.channel, "44");
    assert_eq!(wifi.rx_mbps, Some(1201));
    assert_eq!(wifi.tx_mbps, Some(960));
    assert_eq!(wifi.profile, "ExampleNet");
    let disconnected =
        "    Name                   : Wi-Fi\n    State                  : disconnected\n";
    assert!(!netsh_wlan(disconnected).unwrap().connected);
    assert_eq!(
        netsh_wlan("The Wireless AutoConfig Service (wlansvc) is not running."),
        None
    );
}

#[test]
fn macos_airport_json_reads_signal_and_noise() {
    let json = r#"{"SPAirPortDataType":[{"spairport_airport_interfaces":[
      {"_name":"en0","spairport_current_network_information":{
        "_name":"ExampleNet","spairport_signal_noise":"-52 dBm / -91 dBm",
        "spairport_network_channel":"44 (5GHz, 80MHz)","spairport_network_phymode":"802.11ax",
        "spairport_network_rate":866,"spairport_security_mode":"spairport_security_mode_wpa3_personal"}}]}]}"#;
    let wifi = macos_airport(json).unwrap();
    assert_eq!(wifi.ssid, "ExampleNet");
    assert_eq!(wifi.rssi_dbm, Some(-52));
    assert_eq!(wifi.noise_dbm, Some(-91));
    assert_eq!(wifi.channel, "44");
    assert_eq!(wifi.band, "5GHz");
    assert_eq!(wifi.rx_mbps, Some(866));
}

#[test]
fn nmcli_wifi_handles_escaped_colons() {
    let text = "no:Neighbour:40:1:2412 MHz:54 Mbit/s:WPA2:\nyes:Example\\:Net:78:36:5180 MHz:540 Mbit/s:WPA2 WPA3:wlp3s0\n";
    let wifi = nmcli_wifi(text).unwrap();
    assert_eq!(wifi.ssid, "Example:Net");
    assert_eq!(wifi.signal_percent, Some(78));
    assert_eq!(wifi.channel, "36");
    assert_eq!(wifi.rx_mbps, Some(540));
    assert_eq!(wifi.interface, "wlp3s0");
    assert_eq!(
        nmcli_wifi("no:Other:40:1:2412 MHz:54 Mbit/s:WPA2:wlp3s0\n"),
        None
    );
}

#[test]
fn ping_statistics_on_every_platform() {
    let windows = r#"[{"StatusCode":0,"ResponseTime":12},{"StatusCode":11010,"ResponseTime":0},
                      {"StatusCode":0,"ResponseTime":20}]"#;
    let stats = windows_ping(windows, 4);
    assert_eq!((stats.sent, stats.received), (4, 2));
    assert_eq!(stats.loss_percent, 50.0);
    assert_eq!(stats.avg_ms, Some(16.0));
    assert_eq!(windows_ping("", 3).received, 0);

    let linux = "4 packets transmitted, 3 received, 25% packet loss, time 3004ms\nrtt min/avg/max/mdev = 9.120/10.250/11.300/0.800 ms\n";
    let stats = unix_ping(linux).unwrap();
    assert_eq!((stats.sent, stats.received), (4, 3));
    assert_eq!(stats.loss_percent, 25.0);
    assert_eq!(stats.avg_ms, Some(10.25));

    let macos = "--- 192.0.2.1 ping statistics ---\n3 packets transmitted, 3 packets received, 0.0% packet loss\nround-trip min/avg/max/stddev = 1.1/2.2/3.3/0.9 ms\n";
    let stats = unix_ping(macos).unwrap();
    assert_eq!(stats.received, 3);
    assert_eq!(stats.max_ms, Some(3.3));
    assert_eq!(unix_ping("ping: unknown host"), None);
}

#[test]
fn traceroute_hops_on_windows_and_unix() {
    let windows = "Tracing route to 198.51.100.7 over a maximum of 30 hops\n\n  1    <1 ms    <1 ms     1 ms  192.0.2.1\n\
  2    12 ms    11 ms    13 ms  198.51.100.1\n  3     *        *        *     Request timed out.\n\nTrace complete.\n";
    let hops = tracert(windows);
    assert_eq!(hops.len(), 3);
    assert_eq!(hops[0].address.as_deref(), Some("192.0.2.1"));
    assert_eq!(hops[1].rtt_ms, Some(12.0));
    assert_eq!(hops[2].address, None);

    let unix = "traceroute to 198.51.100.7 (198.51.100.7), 30 hops max\n 1  192.0.2.1  1.234 ms\n 2  *\n 3  198.51.100.7  20.5 ms\n";
    let hops = traceroute(unix);
    assert_eq!(hops.len(), 3);
    assert_eq!(hops[1].address, None);
    assert_eq!(hops[2].rtt_ms, Some(20.5));
}

#[test]
fn neighbours_on_every_platform() {
    let windows =
        r#"[{"ip":"192.0.2.1","mac":"AA-BB-CC-DD-EE-10","interface":"Wi-Fi","state":"Reachable"}]"#;
    assert_eq!(windows_neighbors(windows)[0].mac, "AA-BB-CC-DD-EE-10");
    let linux = r#"[{"dst":"192.0.2.1","dev":"wlp3s0","lladdr":"aa:bb:cc:dd:ee:10","state":["REACHABLE"]}]"#;
    assert_eq!(linux_neighbors(linux)[0].state, "REACHABLE");
    let macos = "? (192.0.2.1) at aa:bb:cc:dd:ee:10 on en0 ifscope [ethernet]\n? (192.0.2.9) at (incomplete) on en0 ifscope [ethernet]\n";
    let neighbors = arp_an(macos);
    assert_eq!(neighbors.len(), 2);
    assert_eq!(neighbors[0].interface, "en0");
    assert_eq!(neighbors[1].state, "incomplete");
}

#[test]
fn dns_answers_skip_the_servers_own_address() {
    let text = "Server:\t\t198.51.100.53\nAddress:\t198.51.100.53#53\n\nNon-authoritative answer:\nName:\texample.com\nAddress: 192.0.2.80\nName:\texample.com\nAddress: 2001:db8::80\n";
    assert_eq!(nslookup(text), ["192.0.2.80", "2001:db8::80"]);
    let windows = "Server:  dns.example\nAddress:  198.51.100.53\n\nName:    example.com\nAddresses:  2001:db8::80\n          192.0.2.80\n";
    assert_eq!(nslookup(windows), ["2001:db8::80", "192.0.2.80"]);
    let resolve = r#"[{"Name":"example.com","Type":1,"IPAddress":"192.0.2.80"},{"Name":"example.com","Type":28,"IPAddress":"2001:db8::80"}]"#;
    assert_eq!(resolve_dns_name(resolve), ["192.0.2.80", "2001:db8::80"]);
}
