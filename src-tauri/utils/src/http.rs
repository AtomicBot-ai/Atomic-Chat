/// Extracts the host (with port if present) from an Origin header value.
pub fn extract_host_from_origin(origin: &str) -> String {
    // Origin format: scheme "://" host [ ":" port ]
    if let Some(after_scheme) = origin.split("://").nth(1) {
        // Take everything up to the first '/' (path), if any
        after_scheme
            .split('/')
            .next()
            .unwrap_or(after_scheme)
            .to_string()
    } else {
        origin.to_string()
    }
}

/// Checks if header name is a CORS-related header
pub fn is_cors_header(header_name: &str) -> bool {
    let header_lower = header_name.to_lowercase();
    header_lower.starts_with("access-control-")
}

/// Validates if host is in trusted hosts list
pub fn is_valid_host(host: &str, trusted_hosts: &[Vec<String>]) -> bool {
    if trusted_hosts
        .iter()
        .any(|hosts| hosts.contains(&"*".to_string()))
    {
        return true;
    }

    if host.is_empty() {
        return false;
    }

    let host_without_port = if host.starts_with('[') {
        host.split(']')
            .next()
            .unwrap_or(host)
            .trim_start_matches('[')
    } else {
        host.split(':').next().unwrap_or(host)
    };
    let default_valid_hosts = ["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal"];

    if default_valid_hosts
        .iter()
        .any(|&valid| host_without_port.to_lowercase() == valid.to_lowercase())
    {
        return true;
    }

    trusted_hosts.iter().flatten().any(|valid| {
        let host_lower = host.to_lowercase();
        let valid_lower = valid.to_lowercase();

        if host_lower == valid_lower {
            return true;
        }

        let valid_without_port = if valid.starts_with('[') {
            valid
                .split(']')
                .next()
                .unwrap_or(valid)
                .trim_start_matches('[')
        } else {
            valid.split(':').next().unwrap_or(valid)
        };

        host_without_port.to_lowercase() == valid_without_port.to_lowercase()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn groups(entries: &[&[&str]]) -> Vec<Vec<String>> {
        entries
            .iter()
            .map(|group| group.iter().map(|entry| entry.to_string()).collect())
            .collect()
    }

    /// The matching rules the Local API Server's dynamic trusted-hosts group
    /// relies on. The function itself is unchanged; these pin its behaviour so
    /// that a future rewrite cannot quietly widen or narrow who gets in.
    #[test]
    fn host_validation_table() {
        let lan = groups(&[&[], &["192.168.1.5"]]);
        let tunnel = groups(&[&["my-host"], &["calm-river-demo.trycloudflare.com"]]);
        let bracketed_v6 = groups(&[&["[fd00::10]"]]);
        let cases: &[(&str, &[Vec<String>], bool)] = &[
            // Loopback spellings need no entry, with or without a port.
            ("localhost", &[], true),
            ("LOCALHOST:1337", &[], true),
            ("127.0.0.1:1337", &[], true),
            ("0.0.0.0:1337", &[], true),
            ("host.docker.internal", &[], true),
            // Nothing else gets in without one.
            ("192.168.1.5:1337", &[], false),
            ("", &[], false),
            // An entry without a port matches the header with any port…
            ("192.168.1.5:1337", &lan, true),
            ("192.168.1.5", &lan, true),
            // …but only that exact address.
            ("192.168.1.50:1337", &lan, false),
            ("192.168.1.6", &lan, false),
            // A tunnel name matches exactly and case-insensitively, in any group.
            ("calm-river-demo.trycloudflare.com", &tunnel, true),
            ("Calm-River-Demo.TryCloudflare.com", &tunnel, true),
            ("my-host:1337", &tunnel, true),
            // No suffix, prefix or wildcard matching.
            ("evil.calm-river-demo.trycloudflare.com", &tunnel, false),
            ("other-name.trycloudflare.com", &tunnel, false),
            ("trycloudflare.com", &tunnel, false),
            // IPv6 literals are compared without their brackets and port.
            ("[fd00::10]:1337", &bracketed_v6, true),
            ("[fd00::11]:1337", &bracketed_v6, false),
        ];
        for (host, trusted, expected) in cases {
            assert_eq!(
                is_valid_host(host, trusted),
                *expected,
                "host {host:?} against {trusted:?}"
            );
        }
    }

    #[test]
    fn a_literal_star_allows_everything_and_patterns_are_not_wildcards() {
        assert!(is_valid_host("anything.example", &groups(&[&["*"]])));
        assert!(is_valid_host("", &groups(&[&["*"]])));
        // `10.*.*.*` is compared as a literal string, as the settings copy says.
        assert!(!is_valid_host("10.1.2.3", &groups(&[&["10.*.*.*"]])));
    }

    #[test]
    fn the_origin_host_keeps_its_port_and_drops_the_path() {
        assert_eq!(
            extract_host_from_origin("https://calm-river-demo.trycloudflare.com"),
            "calm-river-demo.trycloudflare.com"
        );
        assert_eq!(
            extract_host_from_origin("http://192.168.1.5:1337/v1/models"),
            "192.168.1.5:1337"
        );
        assert_eq!(extract_host_from_origin("not-an-origin"), "not-an-origin");
    }
}
