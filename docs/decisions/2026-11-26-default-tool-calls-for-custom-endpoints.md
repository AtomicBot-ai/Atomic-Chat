---
date: 2026-11-26
title: "Use the OpenAI-compatible tool default for custom endpoints"
---

# Use the OpenAI-compatible tool default for custom endpoints

A custom endpoint can list a chat model by ID alone. Atomic Chat applies the OpenAI-compatible tool-calling default to that entry. Provider-specific model lists and per-model engine discovery continue to determine support where available. The composer and outgoing requests read the same saved capability.

Provider store version 17 repairs completion-only entries generated from endpoint model IDs, including the current selection. Catalog entries carry their own capabilities. A user can turn tools off in Edit Model if the server rejects function calls. Refreshing an account-connected endpoint preserves that choice for models the host still lists.

## Selecting a model from a custom endpoint

The saved provider records that the user created it through Custom Endpoint. A configured address and a listed chat model make a keyless endpoint selectable on a LAN or a hosted URL. The proxy registers the same provider for the first turn. Remote model IDs and server names are user-defined, so the picker checks the declared model capabilities and applies local artifact naming rules only outside custom endpoints.

A custom name matching a local engine gets the suffix ` (endpoint)` because the core reserves the engine ID for local sessions. Store version 18 recognizes older endpoints by their saved custom form and updates the active selection when a reserved name changes.
