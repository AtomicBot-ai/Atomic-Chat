//! Parsers for platform network command output. Pure functions over text, so
//! every platform's format is tested on every platform. A parser that does
//! not recognise its input returns empty/`None` rather than guessing; the
//! tools then fall back to showing the raw output.

use std::net::IpAddr;

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Interface {
    pub name: String,
    pub description: String,
    pub status: String,
    pub mac: String,
    pub link_speed: String,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub gateways: Vec<String>,
    pub dns_servers: Vec<String>,
    /// "Enabled"/"Disabled" when known.
    pub dhcp: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct WifiInfo {
    pub interface: String,
    pub connected: bool,
    pub ssid: String,
    pub signal_percent: Option<u8>,
    pub rssi_dbm: Option<i32>,
    pub noise_dbm: Option<i32>,
    pub band: String,
    pub channel: String,
    pub radio: String,
    pub rx_mbps: Option<u32>,
    pub tx_mbps: Option<u32>,
    pub security: String,
    /// The saved profile name (Windows), used to reconnect.
    pub profile: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PingStats {
    pub sent: u32,
    pub received: u32,
    pub loss_percent: f64,
    pub min_ms: Option<f64>,
    pub avg_ms: Option<f64>,
    pub max_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hop {
    pub hop: u32,
    pub address: Option<String>,
    pub rtt_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Neighbor {
    pub ip: String,
    pub mac: String,
    pub interface: String,
    pub state: String,
}

/// PowerShell's `ConvertTo-Json` turns a one-element array into a scalar and
/// an empty one into `{}` or `null`; accept every shape.
fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) if !text.is_empty() => vec![text.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) if !text.is_empty() => Some(text.clone()),
                Value::Number(number) => Some(number.to_string()),
                _ => None,
            })
            .collect(),
        Value::Number(number) => vec![number.to_string()],
        _ => Vec::new(),
    }
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// A single JSON object or an array of them.
fn objects(json: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(json.trim()) {
        Ok(Value::Array(items)) => items,
        Ok(object @ Value::Object(_)) => vec![object],
        _ => Vec::new(),
    }
}

/// Our Windows interfaces script (see `platform::windows_interfaces_script`).
pub fn windows_interfaces(json: &str) -> Vec<Interface> {
    objects(json)
        .iter()
        .map(|item| Interface {
            name: text(item, "alias"),
            description: text(item, "description"),
            status: text(item, "status"),
            mac: text(item, "mac"),
            link_speed: text(item, "linkSpeed"),
            ipv4: strings(item.get("ipv4").unwrap_or(&Value::Null)),
            ipv6: strings(item.get("ipv6").unwrap_or(&Value::Null)),
            gateways: strings(item.get("gateway").unwrap_or(&Value::Null)),
            dns_servers: strings(item.get("dns").unwrap_or(&Value::Null)),
            dhcp: text(item, "dhcp"),
        })
        .filter(|interface| !interface.name.is_empty())
        .collect()
}

/// Linux `ip -j addr` plus `ip -j route` (for gateways).
pub fn linux_interfaces(addr_json: &str, route_json: &str) -> Vec<Interface> {
    let routes = objects(route_json);
    objects(addr_json)
        .iter()
        .map(|item| {
            let name = text(item, "ifname");
            let mut ipv4 = Vec::new();
            let mut ipv6 = Vec::new();
            for info in item
                .get("addr_info")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let local = text(info, "local");
                match text(info, "family").as_str() {
                    "inet" => ipv4.push(local),
                    "inet6" => ipv6.push(local),
                    _ => {}
                }
            }
            let gateways = routes
                .iter()
                .filter(|route| text(route, "dst") == "default" && text(route, "dev") == name)
                .map(|route| text(route, "gateway"))
                .filter(|gateway| !gateway.is_empty())
                .collect();
            Interface {
                status: text(item, "operstate"),
                mac: text(item, "address"),
                name,
                ipv4,
                ipv6,
                gateways,
                ..Interface::default()
            }
        })
        .filter(|interface| !interface.name.is_empty())
        .collect()
}

/// `resolvectl dns` lines: `Link 2 (wlp3s0): 192.168.1.1 1.1.1.1`.
pub fn resolvectl_dns(text: &str) -> Vec<(String, Vec<String>)> {
    text.lines()
        .filter_map(|line| {
            let (head, servers) = line.split_once("):")?;
            let link = head.split_once('(')?.1.trim().to_owned();
            let servers = servers
                .split_whitespace()
                .filter(|server| server.parse::<IpAddr>().is_ok())
                .map(str::to_owned)
                .collect::<Vec<_>>();
            Some((link, servers))
        })
        .collect()
}

/// macOS `ifconfig`: interface blocks with `inet`/`inet6`/`ether`/`status`.
pub fn macos_ifconfig(text: &str) -> Vec<Interface> {
    let mut interfaces: Vec<Interface> = Vec::new();
    for line in text.lines() {
        if !line.starts_with(char::is_whitespace) && line.contains(": flags=") {
            let name = line.split(':').next().unwrap_or_default().to_owned();
            interfaces.push(Interface {
                name,
                ..Interface::default()
            });
            continue;
        }
        let Some(current) = interfaces.last_mut() else {
            continue;
        };
        let mut words = line.split_whitespace();
        match (words.next(), words.next()) {
            (Some("inet"), Some(address)) => current.ipv4.push(address.to_owned()),
            (Some("inet6"), Some(address)) => current
                .ipv6
                .push(address.split('%').next().unwrap_or(address).to_owned()),
            (Some("ether"), Some(mac)) => current.mac = mac.to_owned(),
            (Some("status:"), Some(status)) => current.status = status.to_owned(),
            _ => {}
        }
    }
    interfaces
}

/// macOS `route -n get default`: `gateway: x` and `interface: en0`.
pub fn macos_default_route(text: &str) -> Option<(String, String)> {
    let field = |key: &str| {
        text.lines().find_map(|line| {
            let (name, value) = line.trim().split_once(':')?;
            (name.trim() == key).then(|| value.trim().to_owned())
        })
    };
    Some((field("gateway")?, field("interface")?))
}

/// macOS `scutil --dns`: the unique `nameserver[n] : x` addresses, in order.
pub fn scutil_dns(text: &str) -> Vec<String> {
    let mut servers: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("nameserver[") {
            if let Some((_, server)) = line.split_once(':') {
                let server = server.trim().to_owned();
                if !servers.contains(&server) {
                    servers.push(server);
                }
            }
        }
    }
    servers
}

/// Windows `netsh wlan show interfaces` (English labels).
pub fn netsh_wlan(text: &str) -> Option<WifiInfo> {
    let field = |key: &str| {
        text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim() == key).then(|| value.trim().to_owned())
        })
    };
    let state = field("State")?;
    let number = |key: &str| {
        field(key).and_then(|value| value.trim_end_matches('%').trim().parse::<f64>().ok())
    };
    Some(WifiInfo {
        interface: field("Name").unwrap_or_default(),
        connected: state.eq_ignore_ascii_case("connected"),
        ssid: field("SSID").unwrap_or_default(),
        signal_percent: number("Signal").map(|value| value as u8),
        rssi_dbm: number("Rssi").map(|value| value as i32),
        noise_dbm: None,
        band: field("Band").unwrap_or_default(),
        channel: field("Channel").unwrap_or_default(),
        radio: field("Radio type").unwrap_or_default(),
        rx_mbps: number("Receive rate (Mbps)").map(|value| value as u32),
        tx_mbps: number("Transmit rate (Mbps)").map(|value| value as u32),
        security: field("Authentication").unwrap_or_default(),
        profile: field("Profile").unwrap_or_default(),
    })
}

/// macOS `system_profiler SPAirPortDataType -json`.
pub fn macos_airport(json: &str) -> Option<WifiInfo> {
    let root: Value = serde_json::from_str(json.trim()).ok()?;
    let interfaces = root
        .pointer("/SPAirPortDataType/0/spairport_airport_interfaces")?
        .as_array()?;
    let interface = interfaces
        .iter()
        .find(|item| item.get("spairport_current_network_information").is_some())
        .or_else(|| interfaces.first())?;
    let name = text(interface, "_name");
    let Some(current) = interface.get("spairport_current_network_information") else {
        return Some(WifiInfo {
            interface: name,
            ..WifiInfo::default()
        });
    };
    // "-52 dBm / -91 dBm"
    let (rssi, noise) = text(current, "spairport_signal_noise")
        .split_once('/')
        .map(|(signal, noise)| (dbm(signal), dbm(noise)))
        .unwrap_or((None, None));
    // "44 (5GHz, 80MHz)"
    let channel_text = text(current, "spairport_network_channel");
    let (channel, band) = match channel_text.split_once('(') {
        Some((channel, rest)) => (
            channel.trim().to_owned(),
            rest.split(',').next().unwrap_or_default().trim().to_owned(),
        ),
        None => (channel_text.clone(), String::new()),
    };
    let rate = current
        .get("spairport_network_rate")
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    Some(WifiInfo {
        interface: name,
        connected: true,
        ssid: text(current, "_name"),
        signal_percent: None,
        rssi_dbm: rssi,
        noise_dbm: noise,
        band,
        channel,
        radio: text(current, "spairport_network_phymode"),
        rx_mbps: rate,
        tx_mbps: rate,
        security: text(current, "spairport_security_mode"),
        profile: String::new(),
    })
}

fn dbm(text: &str) -> Option<i32> {
    text.trim().trim_end_matches("dBm").trim().parse().ok()
}

/// `nmcli -t -f ACTIVE,SSID,SIGNAL,CHAN,FREQ,RATE,SECURITY,DEVICE dev wifi`.
pub fn nmcli_wifi(text: &str) -> Option<WifiInfo> {
    let line = text.lines().find(|line| line.starts_with("yes:"))?;
    // nmcli escapes ':' inside values as '\:'.
    let fields = split_nmcli(line);
    let get = |index: usize| fields.get(index).cloned().unwrap_or_default();
    let rate = get(5)
        .split_whitespace()
        .next()
        .and_then(|value| value.parse().ok());
    Some(WifiInfo {
        interface: get(7),
        connected: true,
        ssid: get(1),
        signal_percent: get(2).parse().ok(),
        rssi_dbm: None,
        noise_dbm: None,
        band: get(4),
        channel: get(3),
        radio: String::new(),
        rx_mbps: rate,
        tx_mbps: rate,
        security: get(6),
        profile: get(1),
    })
}

fn split_nmcli(line: &str) -> Vec<String> {
    let mut fields = vec![String::new()];
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    fields.last_mut().unwrap().push(next);
                }
            }
            ':' => fields.push(String::new()),
            _ => fields.last_mut().unwrap().push(c),
        }
    }
    fields
}

/// Windows `Test-Connection` objects (our script selects `StatusCode` and
/// `ResponseTime`), one per echo.
pub fn windows_ping(json: &str, sent: u32) -> PingStats {
    let replies = objects(json)
        .iter()
        .filter(|item| item.get("StatusCode").and_then(Value::as_u64) == Some(0))
        .filter_map(|item| item.get("ResponseTime").and_then(Value::as_f64))
        .collect::<Vec<_>>();
    stats(sent, &replies)
}

/// POSIX `ping` summary (C locale), Linux and macOS formats.
pub fn unix_ping(text: &str) -> Option<PingStats> {
    let summary = text
        .lines()
        .find(|line| line.contains("packets transmitted"))?;
    let numbers = summary
        .split(',')
        .map(|part| {
            part.split_whitespace()
                .next()
                .and_then(|value| value.parse::<u32>().ok())
        })
        .collect::<Vec<_>>();
    let sent = numbers.first().copied().flatten()?;
    let received = numbers.get(1).copied().flatten()?;
    // "rtt min/avg/max/mdev = 9.1/10.2/11.3/0.8 ms" or "round-trip min/avg/max/stddev = ..."
    let (min, avg, max) = text
        .lines()
        .find(|line| line.contains("min/avg/max"))
        .and_then(|line| line.split_once('='))
        .map(|(_, values)| {
            let parts = values
                .trim()
                .trim_end_matches("ms")
                .split('/')
                .map(|value| value.trim().parse::<f64>().ok())
                .collect::<Vec<_>>();
            (
                parts.first().copied().flatten(),
                parts.get(1).copied().flatten(),
                parts.get(2).copied().flatten(),
            )
        })
        .unwrap_or((None, None, None));
    Some(PingStats {
        sent,
        received,
        loss_percent: loss(sent, received),
        min_ms: min,
        avg_ms: avg,
        max_ms: max,
    })
}

fn stats(sent: u32, replies: &[f64]) -> PingStats {
    let received = replies.len() as u32;
    let min = replies.iter().copied().reduce(f64::min);
    let max = replies.iter().copied().reduce(f64::max);
    let avg = (!replies.is_empty()).then(|| replies.iter().sum::<f64>() / replies.len() as f64);
    PingStats {
        sent,
        received,
        loss_percent: loss(sent, received),
        min_ms: min,
        avg_ms: avg,
        max_ms: max,
    }
}

fn loss(sent: u32, received: u32) -> f64 {
    if sent == 0 {
        return 0.0;
    }
    f64::from(sent.saturating_sub(received)) * 100.0 / f64::from(sent)
}

/// Windows `tracert -d`: `  3    12 ms    11 ms    13 ms  10.0.0.1`, or
/// `  4     *        *        *     Request timed out.`
pub fn tracert(text: &str) -> Vec<Hop> {
    text.lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let hop = words.next()?.parse::<u32>().ok()?;
            let rest = words.collect::<Vec<_>>();
            let address = rest
                .iter()
                .rev()
                .find(|word| word.parse::<IpAddr>().is_ok())
                .map(|word| (*word).to_owned());
            let times = rest
                .windows(2)
                .filter(|pair| pair[1] == "ms")
                .filter_map(|pair| pair[0].trim_start_matches('<').parse::<f64>().ok())
                .collect::<Vec<_>>();
            let rtt = (!times.is_empty()).then(|| times.iter().sum::<f64>() / times.len() as f64);
            Some(Hop {
                hop,
                address,
                rtt_ms: rtt,
            })
        })
        .collect()
}

/// POSIX `traceroute -n -q 1`: ` 3  10.0.0.1  12.345 ms` or ` 4  *`.
pub fn traceroute(text: &str) -> Vec<Hop> {
    text.lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let hop = words.next()?.parse::<u32>().ok()?;
            let rest = words.collect::<Vec<_>>();
            let address = rest
                .iter()
                .find(|word| word.parse::<IpAddr>().is_ok())
                .map(|word| (*word).to_owned());
            let rtt = rest
                .windows(2)
                .find(|pair| pair[1] == "ms")
                .and_then(|pair| pair[0].parse::<f64>().ok());
            Some(Hop {
                hop,
                address,
                rtt_ms: rtt,
            })
        })
        .collect()
}

/// Windows `Get-NetNeighbor` objects (our script stringifies `State`).
pub fn windows_neighbors(json: &str) -> Vec<Neighbor> {
    objects(json)
        .iter()
        .map(|item| Neighbor {
            ip: text(item, "ip"),
            mac: text(item, "mac"),
            interface: text(item, "interface"),
            state: text(item, "state"),
        })
        .filter(|neighbor| !neighbor.ip.is_empty())
        .collect()
}

/// Linux `ip -j neigh`.
pub fn linux_neighbors(json: &str) -> Vec<Neighbor> {
    objects(json)
        .iter()
        .map(|item| Neighbor {
            ip: text(item, "dst"),
            mac: text(item, "lladdr"),
            interface: text(item, "dev"),
            state: strings(item.get("state").unwrap_or(&Value::Null)).join(","),
        })
        .filter(|neighbor| !neighbor.ip.is_empty())
        .collect()
}

/// macOS `arp -an`: `? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]`.
pub fn arp_an(text: &str) -> Vec<Neighbor> {
    text.lines()
        .filter_map(|line| {
            let ip = line.split_once('(')?.1.split_once(')')?.0.to_owned();
            let mac = line
                .split_once(" at ")?
                .1
                .split_whitespace()
                .next()?
                .to_owned();
            let interface = line
                .split_once(" on ")
                .and_then(|(_, rest)| rest.split_whitespace().next())
                .unwrap_or_default()
                .to_owned();
            Some(Neighbor {
                ip,
                state: if mac == "(incomplete)" {
                    "incomplete".into()
                } else {
                    "reachable".into()
                },
                mac,
                interface,
            })
        })
        .collect()
}

/// `nslookup <name> <server>`: the addresses after the `Name:` line (the
/// earlier `Address:` belongs to the server itself).
pub fn nslookup(text: &str) -> Vec<String> {
    let mut seen_name = false;
    let mut addresses = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("Name:") {
            seen_name = true;
            continue;
        }
        if !seen_name {
            continue;
        }
        let value = line
            .strip_prefix("Addresses:")
            .or_else(|| line.strip_prefix("Address:"))
            .unwrap_or(line);
        for word in value.split_whitespace() {
            if word.parse::<IpAddr>().is_ok() {
                addresses.push(word.to_owned());
            }
        }
    }
    addresses
}

/// Windows `Resolve-DnsName` objects: the `IPAddress` of A/AAAA answers.
pub fn resolve_dns_name(json: &str) -> Vec<String> {
    objects(json)
        .iter()
        .flat_map(|item| strings(item.get("IPAddress").unwrap_or(&Value::Null)))
        .collect()
}

#[cfg(test)]
#[path = "parse_tests.rs"]
mod tests;
