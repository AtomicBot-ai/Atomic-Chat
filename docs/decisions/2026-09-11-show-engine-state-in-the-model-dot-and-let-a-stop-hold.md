---
date: 2026-09-11
title: "Show engine state in the model dot and let a Stop hold"
---

# 2026-09-11 — Show engine state in the model dot and let a Stop hold

- **Context:** the dot next to the selected model in the chat header doubled
  as the llama.cpp "fits in memory" estimate, so a stopped model that fit
  stayed green, a llama.cpp model never showed that it was starting, and every
  engine re-sync (a fresh `activeModels` array) re-ran the GGUF probe behind a
  spinner. Separately, `ChatInput`'s auto-start effect loads the selected local
  model whenever a composer is on screen, so a Stop in Settings → Providers was
  undone the moment the user opened a chat. The Stop button itself had no
  pending state and swallowed failures in the console. Together: "Stop does
  nothing, or the status lags".
- **Decision:** the dot reports what the engine is doing — green running,
  spinner starting, red load failed, hollow not running. The fit estimate stays
  only as a yellow / red warning on a model that is not running, and is spelled
  out in the tooltip otherwise. A Stop is recorded per provider + model in
  `useAppState.userStoppedModels`; `shouldAttemptAutoStart` skips those, and any
  explicit `switchToModel` — a dropdown pick, Start, or a Send — lifts the
  record. Sending to a stopped model starts it explicitly and holds the message,
  the same way a cold-launch send does (ATO-461).
- **Consequences:** a stopped local model stays down until the user asks for
  it, in line with [not preloading a model](2026-08-19-do-not-preload-a-model-on-startup.md):
  memory is paid only on an expressed intent to chat. Crash recovery
  (session-died → auto-restart, ATO-244) is unchanged for models the user did
  not stop. The record lives in memory only; a relaunch forgets it, which is
  harmless because a launch is cold anyway. A model brought up by another path
  (e.g. starting the Local API Server) while recorded keeps the record until an
  explicit switch, so a crash of that session is not auto-recovered — watch for
  reports. A send held after a Stop is left out of the `reply_model_gate_ready`
  funnel, which measures the reply gate only.
- **Owner:** `team`
- **Links:** `web-app/src/containers/ModelSupportStatus.tsx`,
  `web-app/src/utils/switchModel.ts` (`stopAllLocalModelsByUser`,
  `shouldAttemptAutoStart`), `web-app/src/containers/ChatInput.tsx`,
  `web-app/src/routes/settings/providers/$providerName.tsx`,
  `web-app/src/hooks/useAppState.ts`
