---
date: 2026-10-23
title: "Leave sampling to the user's own server until the assistant is tuned"
---

# 2026-10-23 — Leave sampling to the user's own server until the assistant is tuned

- **Context:** Since
  [2026-08-13](2026-08-13-move-sampling-back-onto-each-assistant.md) every
  assistant carries a sampling bag, seeded from `defaultAssistant.parameters`
  (`temperature 0.7, top_k 20, top_p 0.8, repeat_penalty 1.12`).
  `ModelFactory.createModel` injects that bag into every request to a
  user-added OpenAI-compatible provider (the `default:` case, kept "for
  backwards compat"), and `llamacpp-server` takes the same path. A request
  value beats the server's own, so a user who runs `llama-server` on another
  machine with `--temp`/`--top-k`/`--repeat-penalty` of their choosing, or
  relies on the model's `generation_config`, silently gets the app's defaults
  instead. A Discord user (23 Oct, same `llama-server` instance from Open
  WebUI and from Atomic Chat) asked why the server's sampling defaults are
  not the ones used.
- **Decision:** For providers the app does not run itself (anything outside
  `isLocalInferenceProvider`), the transport sends the panel's sampling knobs
  (`RUN_SETTINGS_SAMPLING_KEYS`) only when the assistant's
  `sampling_overridden` is set, i.e. the user moved a slider. Untuned, they are
  dropped (`withServerSampling` in `lib/sampling-defaults.ts`) and the server's
  sampler applies. Other keys in the bag are kept. The bundled engines keep the
  bag as before; cloud providers never received it. Gemma 4 QAT's recommended
  sampler still layers on top when the assistant is untuned.
- **Consequences:** A custom endpoint answers with the sampler its operator
  configured, which is what Open WebUI and other clients do. A user who wants
  the app's values on their server moves any slider once (or the whole bag is
  sent after any tune). "Reset to default" clears `sampling_overridden`, so it
  hands sampling back to the server, not to the app's defaults, on these
  providers. The sampler popover still shows the app's defaults for an untuned
  assistant even though they are not sent to a custom endpoint — a label for
  that is a follow-up. Not covered: tool definitions still ride every chat
  request as decided in
  [2026-09-02](2026-09-02-measure-and-surface-mcp-tool-cost-in-chat.md); the
  same user measured 67.6 t/s with the model's tools on and 81.4 t/s with them
  off on one server.
- **Owner:** @xDenside
- **Links:** `web-app/src/lib/sampling-defaults.ts` (`withServerSampling`),
  `web-app/src/lib/custom-chat-transport.ts` (`sendMessages`),
  `web-app/src/lib/model-factory.ts` (`createModel`, `default:` case).
