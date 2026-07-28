---
date: 2026-07-28
title: "Test frontend Tauri adapters through official mocks"
---

# 2026-07-28 — Test frontend Tauri adapters through official mocks

- **Context:** Frontend tests globally replaced `useServiceHub` and mocked
  `@tauri-apps/api/core`, so service tests could pass without executing the
  production Tauri adapters or Tauri's IPC serialization path.
- **Decision:** UI and hook tests explicitly seed the real ServiceHub Zustand
  store with typed test services. IPC-boundary tests execute real
  `services/*/tauri.ts` implementations against `@tauri-apps/api/mocks`, and
  shared setup clears mock state after every test.
- **Consequences:** Command names, argument shapes, events, window metadata,
  and asset URL conversion are tested through Tauri's JavaScript runtime.
  Tests must not combine `mockIPC` with a module mock of
  `@tauri-apps/api/core`, and new UI suites must opt into only the services
  they require.
- **Owner:** team
- **Links:** `web-app/src/test/setup.ts`,
  `web-app/src/test/service-hub.ts`,
  `web-app/src/services/__tests__/core.tauri.test.ts`,
  `web-app/src/lib/__tests__/ipc-contract.test.ts`
