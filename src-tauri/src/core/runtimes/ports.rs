//! Hands out loopback ports to the runtimes Radium starts itself.
//!
//! Managed runtimes get a port from a private range that nothing else Radium
//! runs uses: the facade is on 1337 and chat's llama.cpp servers pick from
//! 3000-3999 (`jan_utils::generate_random_port`). Well-known ports of runtimes
//! the user runs (Ollama's 11434, ComfyUI's 8188 and so on) sit outside the
//! range, so a managed child never takes the port an attached runtime expects.
//!
//! A lease releases its port when dropped, so a runtime that fails to start
//! cannot leak one.

use std::{
    collections::HashSet,
    net::TcpListener,
    ops::RangeInclusive,
    sync::{Arc, Mutex},
};

/// The ports managed runtimes are started on.
pub const MANAGED_PORT_RANGE: RangeInclusive<u16> = 39000..=39999;

/// Ports inside or outside the range that must never be handed out.
const RESERVED: &[u16] = &[1337];

#[derive(Debug, Clone, Default)]
pub struct PortBroker {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Debug, Default)]
struct Inner {
    leased: HashSet<u16>,
    next: u16,
}

/// A port held for one runtime instance. Dropping it gives the port back.
#[derive(Debug)]
pub struct PortLease {
    port: u16,
    broker: Arc<Mutex<Inner>>,
}

impl PortLease {
    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for PortLease {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.broker.lock() {
            inner.leased.remove(&self.port);
        }
    }
}

impl PortBroker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Leases a port in [`MANAGED_PORT_RANGE`] that is neither leased nor
    /// bound by any other program right now.
    pub fn lease(&self) -> Result<PortLease, String> {
        self.lease_in(MANAGED_PORT_RANGE, is_free_on_loopback)
    }

    /// The same as [`lease`](Self::lease) over any range and availability
    /// check, so tests do not depend on what the machine has open.
    pub fn lease_in(
        &self,
        range: RangeInclusive<u16>,
        is_free: impl Fn(u16) -> bool,
    ) -> Result<PortLease, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "The port broker is unavailable".to_string())?;
        let (start, end) = (*range.start(), *range.end());
        let size = u32::from(end - start) + 1;
        // Rotate through the range instead of always starting at its bottom,
        // so a port just released is not reused while the old process may
        // still be shutting down.
        let offset = if (start..=end).contains(&inner.next) {
            inner.next - start
        } else {
            0
        };
        for step in 0..size {
            let port = start + ((u32::from(offset) + step) % size) as u16;
            if RESERVED.contains(&port) || inner.leased.contains(&port) {
                continue;
            }
            if !is_free(port) {
                continue;
            }
            inner.leased.insert(port);
            inner.next = if port == end { start } else { port + 1 };
            return Ok(PortLease {
                port,
                broker: Arc::clone(&self.inner),
            });
        }
        Err(format!("No free port between {start} and {end}"))
    }

    /// How many ports are leased right now.
    pub fn leased_count(&self) -> usize {
        self.inner.lock().map(|inner| inner.leased.len()).unwrap_or(0)
    }
}

/// True when nothing is listening on `port` on 127.0.0.1.
pub fn is_free_on_loopback(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::runtimes::registry::RUNTIMES;

    #[test]
    fn the_managed_range_avoids_every_port_radium_or_a_known_runtime_uses() {
        // Radium's facade and chat's llama.cpp range.
        assert!(!MANAGED_PORT_RANGE.contains(&1337));
        assert!(!MANAGED_PORT_RANGE.contains(&3000));
        assert!(!MANAGED_PORT_RANGE.contains(&3999));
        for runtime in RUNTIMES {
            if let Some(port) = runtime.default_port {
                assert!(
                    !MANAGED_PORT_RANGE.contains(&port),
                    "{} listens on {port}",
                    runtime.id
                );
            }
        }
    }

    #[test]
    fn leases_are_unique_and_come_back_when_dropped() {
        let broker = PortBroker::new();
        let first = broker.lease_in(40000..=40002, |_| true).unwrap();
        let second = broker.lease_in(40000..=40002, |_| true).unwrap();
        let third = broker.lease_in(40000..=40002, |_| true).unwrap();
        let ports: HashSet<_> = [first.port(), second.port(), third.port()].into();
        assert_eq!(ports.len(), 3);
        assert!(broker.lease_in(40000..=40002, |_| true).is_err());

        let freed = second.port();
        drop(second);
        assert_eq!(broker.leased_count(), 2);
        assert_eq!(broker.lease_in(40000..=40002, |_| true).unwrap().port(), freed);
    }

    #[test]
    fn a_port_another_program_holds_is_skipped() {
        let broker = PortBroker::new();
        let lease = broker.lease_in(40010..=40012, |port| port != 40010).unwrap();
        assert_eq!(lease.port(), 40011);
    }

    #[test]
    fn a_released_port_is_not_reused_straight_away() {
        let broker = PortBroker::new();
        let first = broker.lease_in(40020..=40022, |_| true).unwrap();
        let port = first.port();
        drop(first);
        let next = broker.lease_in(40020..=40022, |_| true).unwrap();
        assert_ne!(next.port(), port);
    }

    #[test]
    fn a_port_bound_on_loopback_is_not_free() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!is_free_on_loopback(port));
        drop(listener);
    }
}
