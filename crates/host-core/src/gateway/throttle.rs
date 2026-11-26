//! Per-peer throttle for failed credential attempts on the upgrade path.
//! Device tokens carry 256 bits, so this is not about guessing; it keeps a
//! misbehaving client from turning every retry into pi-host work.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const DEFAULT_WINDOW: Duration = Duration::from_secs(60);
pub const DEFAULT_MAX_FAILURES: u32 = 10;
const MAX_TRACKED_PEERS: usize = 10_000;

pub struct AuthThrottle {
    window: Duration,
    max_failures: u32,
    peers: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl AuthThrottle {
    pub fn new(window: Duration, max_failures: u32) -> Self {
        Self {
            window,
            max_failures,
            peers: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_blocked(&self, peer: IpAddr, now: Instant) -> bool {
        let peers = self
            .peers
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        peers.get(&peer).is_some_and(|(start, count)| {
            now.duration_since(*start) < self.window && *count >= self.max_failures
        })
    }

    pub fn record_failure(&self, peer: IpAddr, now: Instant) {
        let mut peers = self
            .peers
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if peers.len() >= MAX_TRACKED_PEERS {
            let window = self.window;
            peers.retain(|_, (start, _)| now.duration_since(*start) < window);
        }
        let entry = peers.entry(peer).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_limit_and_recovers_after_window() {
        let throttle = AuthThrottle::new(Duration::from_secs(60), 3);
        let peer: IpAddr = "203.0.113.7".parse().unwrap();
        let other: IpAddr = "203.0.113.8".parse().unwrap();
        let t0 = Instant::now();
        for _ in 0..3 {
            assert!(!throttle.is_blocked(peer, t0));
            throttle.record_failure(peer, t0);
        }
        assert!(throttle.is_blocked(peer, t0));
        assert!(!throttle.is_blocked(other, t0));
        assert!(!throttle.is_blocked(peer, t0 + Duration::from_secs(61)));
    }
}
