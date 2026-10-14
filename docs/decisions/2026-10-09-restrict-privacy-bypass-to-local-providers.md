---
date: 2026-10-09
title: "Restrict privacy bypass to recognized local providers"
---

# Restrict privacy bypass to recognized local providers

- **Context:** A loopback endpoint can forward requests to a remote model, so its address does not establish that messages stay on the device.
- **Decision:** Only recognized local inference providers bypass the enabled privacy gate. Remove the automatic loopback exemption for other providers; no additional trusted-endpoint opt-in is introduced.
- **Consequences:** Custom and self-hosted providers on loopback receive redacted requests when the gate is enabled. Subscription providers continue to use the gate, and recognized local providers remain unchanged. This clarifies the egress boundary described in the [original privacy decision](2026-10-07-port-privacy-gpu-telemetry-and-benchmarking-through-radium-native-boundaries.md).
