---
date: 2026-09-17
title: "Re-point the web-app test storage globals at jsdom on Node ≥ 25"
---

# 2026-09-17 — Re-point the web-app test storage globals at jsdom on Node ≥ 25

- **Context:** Node ≥ 25 defines `localStorage`/`sessionStorage` on its own
  global by default; without `--localstorage-file` they read as `undefined`
  and print an `ExperimentalWarning`. Vitest 3.2.4's jsdom environment
  (`populateGlobal` / `getWindowKeys`) keeps every global Node already owns
  unless it is on Vitest's own key list, which names `Storage` but not
  `localStorage` / `sessionStorage`. So under Node 26.8.1 the bare
  `localStorage` in a spec resolves to Node's empty global, and the 42 web-app
  test files that call it failed at `localStorage.clear()` before any
  assertion. `NODE_OPTIONS=--no-experimental-webstorage` was the only
  workaround, and it had to be typed per invocation.
- **Decision:** `web-app/src/test/setup.ts` redefines `localStorage` and
  `sessionStorage` on the global as writable, configurable data properties
  holding the jsdom window's `Storage`. The jsdom window is reached through
  `frames`: Vitest aliases `window`, `self`, `top`, `parent` and
  `document.defaultView` to the Node global but leaves `frames` pointing at
  the real jsdom window. The block runs inside `vi.hoisted` so it precedes the
  setup file's own imports, because zustand `persist` stores call
  `createJSONStorage(() => localStorage)` while their module loads.
  Rejected: `NODE_OPTIONS` in the `test` scripts and Makefile (shell-specific
  syntax that fails in `cmd.exe`, and misses direct `vitest` and IDE runs);
  `poolOptions.forks.execArgv: ['--no-experimental-webstorage']` (Vitest
  builds worker pools from the root config only, so it would have to live in
  both `vitest.config.ts` files, it is pool-specific, and Node 20 — the
  documented minimum and the release workflow's version — rejects the flag
  as an unknown option).
- **Consequences:** The web-app suite runs on any supported Node with no env
  vars, from `web-app/`, from the root `projects` config and from IDE runners,
  and the warning is gone from test output. Specs keep jsdom `Storage`
  semantics, and the two that `Object.defineProperty(window, 'localStorage',
  …)` still work because the property stays configurable. Failure modes are
  loud: if Vitest ever aliases `frames` to the Node global the shim becomes a
  no-op and the storage-using files fail at `.clear()` again; if Node makes
  the property non-configurable, `defineProperty` throws during setup. Core
  and the llamacpp extensions keep their own jsdom setups; their storage-using
  specs pass on Node 26 as they are, so they were left alone.
- **Owner:** `team`
- **Links:** `web-app/src/test/setup.ts`, `web-app/vitest.config.ts`,
  `vitest.config.ts`, `node_modules/vitest/dist/chunks/index.*.js`
  (`getWindowKeys`), https://nodejs.org/api/cli.html#--localstorage-filefile,
  https://vitest.dev/api/vi.html#vi-hoisted
