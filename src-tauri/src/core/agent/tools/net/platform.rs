//! The fixed command for every `net.*` operation on every platform. The model
//! never writes these: it picks a tool, and the tool runs the vetted command
//! for the OS it is on, with user values quoted (Windows) or passed as
//! separate argv entries (Unix).

use super::run::{ps_array, ps_quote, CommandSpec};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
    Other,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Windows => "Windows",
            Self::Mac => "macOS",
            Self::Linux => "Linux",
            Self::Other => "this operating system",
        }
    }
}

/// Every interface with addresses, gateway, DNS and DHCP state as JSON.
pub const WINDOWS_INTERFACES: &str = "$ErrorActionPreference='SilentlyContinue'; \
$items = @(Get-NetIPConfiguration -All | ForEach-Object { \
  $adapter = $_.NetAdapter; \
  [pscustomobject]@{ \
    alias = $_.InterfaceAlias; description = $_.InterfaceDescription; \
    status = [string]$adapter.Status; mac = [string]$adapter.MacAddress; linkSpeed = [string]$adapter.LinkSpeed; \
    ipv4 = @($_.IPv4Address | ForEach-Object { $_.IPAddress }); \
    ipv6 = @($_.IPv6Address | ForEach-Object { $_.IPAddress }); \
    gateway = @($_.IPv4DefaultGateway | ForEach-Object { $_.NextHop }); \
    dns = @($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses }); \
    dhcp = [string]$_.NetIPv4Interface.Dhcp } }); \
ConvertTo-Json -InputObject $items -Depth 4 -Compress";

pub const WINDOWS_NEIGHBORS: &str = "$ErrorActionPreference='SilentlyContinue'; \
$items = @(Get-NetNeighbor -AddressFamily IPv4 | Where-Object { $_.State -ne 'Unreachable' -and $_.State -ne 'Permanent' } | \
  ForEach-Object { [pscustomobject]@{ ip = $_.IPAddress; mac = $_.LinkLayerAddress; interface = $_.InterfaceAlias; state = [string]$_.State } }); \
ConvertTo-Json -InputObject $items -Compress";

pub fn interfaces(os: Os) -> Vec<CommandSpec> {
    match os {
        Os::Windows => vec![CommandSpec::powershell(WINDOWS_INTERFACES)],
        Os::Mac => vec![
            CommandSpec::new("ifconfig", &[]),
            CommandSpec::new("route", &["-n", "get", "default"]),
            CommandSpec::new("scutil", &["--dns"]),
            CommandSpec::new("networksetup", &["-listallhardwareports"]),
        ],
        Os::Linux => vec![
            CommandSpec::new("ip", &["-j", "addr"]),
            CommandSpec::new("ip", &["-j", "route"]),
            CommandSpec::new("resolvectl", &["dns"]),
        ],
        Os::Other => Vec::new(),
    }
}

pub fn wifi_status(os: Os) -> Option<CommandSpec> {
    match os {
        Os::Windows => Some(CommandSpec::new("netsh", &["wlan", "show", "interfaces"])),
        Os::Mac => Some(CommandSpec::new(
            "system_profiler",
            &["SPAirPortDataType", "-json"],
        )),
        Os::Linux => Some(CommandSpec::new(
            "nmcli",
            &[
                "-t",
                "-f",
                "ACTIVE,SSID,SIGNAL,CHAN,FREQ,RATE,SECURITY,DEVICE",
                "dev",
                "wifi",
            ],
        )),
        Os::Other => None,
    }
}

pub fn neighbors(os: Os) -> Option<CommandSpec> {
    match os {
        Os::Windows => Some(CommandSpec::powershell(WINDOWS_NEIGHBORS)),
        Os::Mac => Some(CommandSpec::new("arp", &["-an"])),
        Os::Linux => Some(CommandSpec::new("ip", &["-j", "neigh"])),
        Os::Other => None,
    }
}

pub fn ping(os: Os, host: &str, count: u32) -> Option<CommandSpec> {
    let count_text = count.to_string();
    match os {
        Os::Windows => Some(CommandSpec::powershell(&format!(
            "$ErrorActionPreference='SilentlyContinue'; \
             $items = @(Test-Connection -ComputerName {host} -Count {count} -ErrorAction SilentlyContinue | \
               Select-Object StatusCode, ResponseTime); \
             ConvertTo-Json -InputObject $items -Compress",
            host = ps_quote(host),
            count = count,
        ))),
        Os::Mac | Os::Linux => Some(CommandSpec::new("ping", &["-c", &count_text, host])),
        Os::Other => None,
    }
}

pub fn traceroute(os: Os, host: &str, max_hops: u32) -> Option<CommandSpec> {
    let hops = max_hops.to_string();
    match os {
        Os::Windows => Some(CommandSpec::new(
            "tracert",
            &["-d", "-h", &hops, "-w", "800", host],
        )),
        Os::Mac | Os::Linux => Some(CommandSpec::new(
            "traceroute",
            &["-n", "-q", "1", "-w", "1", "-m", &hops, host],
        )),
        Os::Other => None,
    }
}

/// A lookup against one named DNS server (the system resolver is queried
/// natively instead).
pub fn dns_lookup_via(os: Os, name: &str, server: &str) -> Option<CommandSpec> {
    match os {
        Os::Windows => Some(CommandSpec::powershell(&format!(
            "$ErrorActionPreference='Stop'; \
             $items = @(Resolve-DnsName -Name {name} -Server {server} -DnsOnly -QuickTimeout | \
               Where-Object {{ $_.Type -eq 'A' -or $_.Type -eq 'AAAA' }} | Select-Object Name, IPAddress); \
             ConvertTo-Json -InputObject $items -Compress",
            name = ps_quote(name),
            server = ps_quote(server),
        ))),
        Os::Mac | Os::Linux => Some(CommandSpec::new("nslookup", &[name, server])),
        Os::Other => None,
    }
}

// ---------------------------------------------------------------- fixes ----

/// What a fix runs: the command, and how to retry it with admin rights.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixCommand {
    pub spec: CommandSpec,
    /// The same operation behind the OS's admin prompt.
    pub elevated: Elevated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Elevated {
    /// A Windows PowerShell script to run through UAC. (macOS fixes that need
    /// root go straight to the admin prompt in `spec`.)
    WindowsScript(String),
    /// Run `spec` through pkexec.
    LinuxPkexec,
    /// Admin rights would not help.
    NotApplicable,
}

pub fn dns_flush(os: Os) -> Option<FixCommand> {
    match os {
        Os::Windows => Some(FixCommand {
            spec: CommandSpec::new("ipconfig", &["/flushdns"]),
            elevated: Elevated::WindowsScript("ipconfig /flushdns".into()),
        }),
        // Both steps need root on macOS, so go straight to the prompt.
        Os::Mac => Some(FixCommand {
            spec: super::run::macos_elevated("dscacheutil -flushcache; killall -HUP mDNSResponder"),
            elevated: Elevated::NotApplicable,
        }),
        Os::Linux => Some(FixCommand {
            spec: CommandSpec::new("resolvectl", &["flush-caches"]),
            elevated: Elevated::LinuxPkexec,
        }),
        Os::Other => None,
    }
}

pub fn dhcp_renew(os: Os, adapter: Option<&str>) -> Option<FixCommand> {
    match os {
        Os::Windows => {
            let script = match adapter {
                Some(adapter) => format!(
                    "ipconfig /release {name} | Out-Null; ipconfig /renew {name}",
                    name = ps_quote(adapter)
                ),
                None => "ipconfig /renew".into(),
            };
            Some(FixCommand {
                spec: CommandSpec::powershell(&script),
                elevated: Elevated::WindowsScript(script),
            })
        }
        Os::Mac => {
            let device = adapter?;
            Some(FixCommand {
                spec: super::run::macos_elevated(&format!(
                    "ipconfig set {} DHCP",
                    super::run::sh_quote(device)
                )),
                elevated: Elevated::NotApplicable,
            })
        }
        Os::Linux => {
            let device = adapter?;
            Some(FixCommand {
                spec: CommandSpec::new("nmcli", &["device", "reapply", device]),
                elevated: Elevated::LinuxPkexec,
            })
        }
        Os::Other => None,
    }
}

pub fn adapter_restart(os: Os, adapter: &str) -> Option<FixCommand> {
    match os {
        Os::Windows => {
            let script = format!(
                "Restart-NetAdapter -Name {} -Confirm:$false",
                ps_quote(adapter)
            );
            Some(FixCommand {
                spec: CommandSpec::powershell(&format!("$ErrorActionPreference='Stop'; {script}")),
                elevated: Elevated::WindowsScript(script),
            })
        }
        Os::Mac => {
            let device = super::run::sh_quote(adapter);
            Some(FixCommand {
                spec: super::run::macos_elevated(&format!(
                    "ifconfig {device} down; sleep 2; ifconfig {device} up"
                )),
                elevated: Elevated::NotApplicable,
            })
        }
        Os::Linux => Some(FixCommand {
            spec: CommandSpec::new(
                "sh",
                &[
                    "-c",
                    "nmcli device disconnect \"$1\" && sleep 2 && nmcli device connect \"$1\"",
                    "radium-net",
                    adapter,
                ],
            ),
            elevated: Elevated::LinuxPkexec,
        }),
        Os::Other => None,
    }
}

/// `servers` empty means "back to automatic (DHCP)".
pub fn set_dns(os: Os, adapter: &str, servers: &[String]) -> Option<FixCommand> {
    match os {
        Os::Windows => {
            let script = if servers.is_empty() {
                format!(
                    "Set-DnsClientServerAddress -InterfaceAlias {} -ResetServerAddresses",
                    ps_quote(adapter)
                )
            } else {
                format!(
                    "Set-DnsClientServerAddress -InterfaceAlias {} -ServerAddresses {}",
                    ps_quote(adapter),
                    ps_array(servers)
                )
            };
            Some(FixCommand {
                spec: CommandSpec::powershell(&format!("$ErrorActionPreference='Stop'; {script}")),
                elevated: Elevated::WindowsScript(script),
            })
        }
        Os::Mac => {
            // `adapter` is a network service name here (e.g. "Wi-Fi").
            let mut command = format!(
                "networksetup -setdnsservers {}",
                super::run::sh_quote(adapter)
            );
            if servers.is_empty() {
                command.push_str(" Empty");
            } else {
                for server in servers {
                    command.push(' ');
                    command.push_str(&super::run::sh_quote(server));
                }
            }
            Some(FixCommand {
                spec: super::run::macos_elevated(&command),
                elevated: Elevated::NotApplicable,
            })
        }
        Os::Linux => {
            let script = if servers.is_empty() {
                "con=$(nmcli -g GENERAL.CONNECTION device show \"$1\") && \
                 nmcli connection modify \"$con\" ipv4.dns '' ipv4.ignore-auto-dns no && \
                 nmcli connection up \"$con\""
            } else {
                "con=$(nmcli -g GENERAL.CONNECTION device show \"$1\") && \
                 nmcli connection modify \"$con\" ipv4.dns \"$2\" ipv4.ignore-auto-dns yes && \
                 nmcli connection up \"$con\""
            };
            let joined = servers.join(" ");
            Some(FixCommand {
                spec: CommandSpec::new("sh", &["-c", script, "radium-net", adapter, &joined]),
                elevated: Elevated::LinuxPkexec,
            })
        }
        Os::Other => None,
    }
}

pub fn wifi_reconnect(os: Os, interface: &str, profile: &str) -> Option<FixCommand> {
    match os {
        Os::Windows => {
            let script = format!(
                "netsh wlan disconnect interface={iface} | Out-Null; Start-Sleep -Seconds 2; \
                 netsh wlan connect name={profile} interface={iface}",
                iface = ps_quote(interface),
                profile = ps_quote(profile),
            );
            Some(FixCommand {
                spec: CommandSpec::powershell(&script),
                elevated: Elevated::NotApplicable,
            })
        }
        Os::Mac => Some(FixCommand {
            spec: CommandSpec::new(
                "sh",
                &[
                    "-c",
                    "networksetup -setairportpower \"$1\" off && sleep 2 && networksetup -setairportpower \"$1\" on",
                    "radium-net",
                    interface,
                ],
            ),
            elevated: Elevated::NotApplicable,
        }),
        Os::Linux => Some(FixCommand {
            spec: CommandSpec::new(
                "sh",
                &[
                    "-c",
                    "nmcli device disconnect \"$1\" && sleep 2 && nmcli device connect \"$1\"",
                    "radium-net",
                    interface,
                ],
            ),
            elevated: Elevated::LinuxPkexec,
        }),
        Os::Other => None,
    }
}

/// Windows only: reset Winsock and the TCP/IP stack (takes effect on reboot).
pub fn stack_reset(os: Os) -> Option<FixCommand> {
    match os {
        Os::Windows => {
            let script = "netsh winsock reset; netsh int ip reset".to_owned();
            Some(FixCommand {
                spec: CommandSpec::powershell(&script),
                elevated: Elevated::WindowsScript(script),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_fix_exists_on_windows() {
        let os = Os::Windows;
        assert!(dns_flush(os).is_some());
        assert!(dhcp_renew(os, None).is_some());
        assert!(adapter_restart(os, "Wi-Fi").is_some());
        assert!(set_dns(os, "Wi-Fi", &["1.1.1.1".into()]).is_some());
        assert!(wifi_reconnect(os, "Wi-Fi", "Home").is_some());
        assert!(stack_reset(os).is_some());
    }

    #[test]
    fn adapter_names_are_quoted_not_spliced() {
        let hostile = "Wi-Fi'; Remove-Item -Recurse C:\\; '";
        let fix = set_dns(Os::Windows, hostile, &["1.1.1.1".into()]).unwrap();
        let script = fix.spec.args.last().unwrap();
        assert!(script.contains("-InterfaceAlias 'Wi-Fi''; Remove-Item -Recurse C:\\; '''"));
        // Unix variants pass the name as its own argv entry.
        let fix = adapter_restart(Os::Linux, "wlp3s0; rm -rf /").unwrap();
        assert_eq!(fix.spec.args.last().unwrap(), "wlp3s0; rm -rf /");
        assert!(!fix.spec.args[1].contains("rm -rf"));
    }

    #[test]
    fn automatic_dns_resets_instead_of_setting_nothing() {
        let windows = set_dns(Os::Windows, "Wi-Fi", &[]).unwrap();
        assert!(windows
            .spec
            .args
            .last()
            .unwrap()
            .contains("-ResetServerAddresses"));
        let mac = set_dns(Os::Mac, "Wi-Fi", &[]).unwrap();
        assert!(mac.spec.args.last().unwrap().contains("Empty"));
    }

    #[test]
    fn windows_only_and_device_bound_fixes_say_so() {
        assert!(stack_reset(Os::Mac).is_none());
        assert!(stack_reset(Os::Linux).is_none());
        // macOS/Linux renew a specific device; there is no "all adapters" form.
        assert!(dhcp_renew(Os::Mac, None).is_none());
        assert!(dhcp_renew(Os::Linux, Some("wlp3s0")).is_some());
    }

    #[test]
    fn unix_diagnostics_pass_hosts_as_separate_arguments() {
        let ping = ping(Os::Linux, "example.com", 3).unwrap();
        assert_eq!(ping.args, ["-c", "3", "example.com"]);
        let trace = traceroute(Os::Mac, "example.com", 15).unwrap();
        assert_eq!(trace.args.last().unwrap(), "example.com");
        assert!(trace.args.contains(&"15".to_owned()));
    }
}
