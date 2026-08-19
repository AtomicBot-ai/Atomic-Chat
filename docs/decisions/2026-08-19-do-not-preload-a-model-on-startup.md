---
date: 2026-08-19
title: "Do not preload a model on startup"
---

# 2026-08-19 — Do not preload a model on startup

- **Context:** `preloadModelOnStartup` defaulted to on, so every launch restored
  `lastUsedModel` (or auto-picked the first local model), which made
  `ChatInput`'s auto-start effect spawn `llama-server` and pull gigabytes of
  weights into RAM before the user had typed anything. Opening the app to read
  an old thread, change a setting, or talk to a cloud provider cost a full local
  model load.
- **Decision:** default `preloadModelOnStartup` to `false`. A cold launch stays
  cold: the picker renders blank (or reflects a model that is genuinely still
  running) and a model is loaded only when the user selects one in the model
  dropdown, through the explicit `switchToModel` path. The setting keeps its
  toggle, moved next to "Launch at startup" in Settings → General and finally
  translated. No persist migration — the flag is already written into
  `setting-general` for existing users, and they keep the behaviour they have
  until they change it themselves.
- **Consequences:** first paint is no longer gated on a model load, and users
  who never chat locally never pay for one. The cost is one extra click to start
  chatting on a fresh profile, and "no model selected" becomes the normal state
  at launch — the inline hint in `ChatInput` that covers it is now a translated
  string instead of hardcoded English. Existing users see no change until they
  reinstall or flip the toggle, so support answers must ask which of the two
  states a reporter is in. The Local API Server is unaffected: it still comes up
  with the model (`switchModel.ts` `shouldStartServer`) and still stays down
  when nothing is running (`DataProvider` startup effect).
- **Owner:** `team`
- **Links:** `web-app/src/hooks/useGeneralSetting.ts`,
  `web-app/src/main.tsx`, `web-app/src/containers/DropdownModelProvider.tsx`,
  `web-app/src/routes/settings/general.tsx`,
  [launch-at-startup companion decision](2026-08-19-leave-launch-at-startup-off-for-new-installs.md)
