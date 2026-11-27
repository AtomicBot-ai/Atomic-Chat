---
date: 2026-11-27
title: "Use the chat run settings for pi tasks"
---

# Use the chat run settings for pi tasks

Chat and Agent share their start screen and run settings panel. The editor keeps the controls for the active mode. A task binds the assistant selected for its first message. Older unbound tasks use the default assistant. Project tasks inherit the current project assistant until the user chooses an assistant or selects None for that task.

Each new idle turn resolves the current assistant instructions and the served model's sampling settings. The local model receives the same model-family and engine adjustments as Chat. The bundled pi extension applies the seven numeric sampling controls when preparing the provider payload and preserves pi's messages, tools, streaming and token limits. Remote providers keep their own sampler. Saved settings use the existing assistant store.

The model menu controls reasoning effort in both modes. Before sending a task message, Atomic resolves the saved effort against the served model and applies it to the pi session, including resumed sessions. The header context indicator shows pi's reported token usage and offers compaction once the history exceeds pi's retention threshold.
