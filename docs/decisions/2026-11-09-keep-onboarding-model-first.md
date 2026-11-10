---
date: 2026-11-09
title: "Keep onboarding model-first and install the model's engine"
---

# 2026-11-09 — Keep onboarding model-first and install the model's engine

Supersedes the explicit engine selector clause of [the desktop handoff decision](2026-11-09-preserve-fastflowlm-desktop-handoff-invariants.md).

- **Context:** The operator requested the original onboarding interaction: choose a model and derive its provider, without a separate engine selector. The Linux native select also ignored the dark appearance. Continue could stop with an opaque `[object Object]` error; direct checks on the QA host confirmed a valid descriptor with `engine-not-installed`, and desktop logs separately showed core connectivity failures.
- **Decision:** Remove the engine picker and filtering from onboarding. Keep the usual GGUF/MLX/library offers and the FLM variants selectable directly. Preserve the model choice across Back/relaunch; migrate the QA profile's previous engine-specific selection to that model without discarding jobs. A missing engine or a required newer build makes Continue install the selected model's FastFlowLM engine through the existing core engine-build API, then perform a fresh model check before downloading model files. Core still owns build selection and verification; no platform policy moves into React.
- **Progress and recovery:** Onboarding and the engine panel share one in-flight install and its progress. Pending checks disable repeated Continue requests. Readiness blockers stay inline; the NPU preparation panel opens before the model list only when the fresh verdict requires it. The engine settings/install card is not part of the initial onboarding screen; structured core errors display their message. Changing the selected model or leaving onboarding prevents a late response from advancing the old choice. Cancellation does not become a failed model download. Engine installation does not grant consent to system-level NPU changes.
- **Alternatives:** A new themed engine menu would retain the interaction the operator explicitly rejected. An informational error alone leaves a missing prerequisite unresolved. Downloading model payloads before a fresh post-install verdict could consume several gigabytes for an environment that cannot load the model. Automatic host-step consent would bypass the existing plan review and OS authorization.
- **Consequences:** Onboarding follows each selected model's provider instead of a persistent engine filter. This explicitly overrides the CLI handoff's engine-first UI preference for desktop onboarding; Model Hub keeps its existing engine filters. The original GGUF-to-upstream and MLX-to-MLX mapping stays intact. Core connectivity faults remain distinct from a missing engine; they are not hidden by a fabricated ready verdict.
- **Owner:** team.
- **Links:** [Onboarding](../../web-app/src/containers/onboarding/steps/ModelStep.tsx), [shared FLM engine install](../../web-app/src/services/engine-builds/fastflowlm.ts), [persisted selection](../../web-app/src/stores/onboarding-store.ts).
