---
date: 2026-11-19
title: "Edit engine context length from chat"
---

# Edit engine context length from chat

Strata, FastFlowLM, GenieX, LiteRT-LM and the managed engines read context length from their provider settings when they load a model. The chat header writes that same setting and restarts the selected model only if it is loaded in that provider. Other models pick up the value on their next load. A notification stays visible when the chat control closes and distinguishes stopping the current session from loading with the new setting. It reports success once the model is active again.

Strata takes its default from the catalog and its maximum from the installed GGUF through the core. The manual step is 1024 tokens, except for FastFlowLM which requires powers of two. The selector bounds its presets by the selected model's advertised limit when available. Automatic sizing stays available on engines that support it. When the automatic capacity depends on the device or is unknown, the header shows Auto and the token counts.

For managed engines, the core reports the text config's context limit through model capabilities. Manual selection requires that limit and also respects the provider's settings and KV cache bounds.

Owner: team.
