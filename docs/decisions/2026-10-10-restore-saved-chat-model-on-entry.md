# Restore the saved chat model on entry

- Status: Accepted
- Date: 2026-10-10
- Scope: ATO-485

## Context
Threads already persist their model, but the composer uses the global selection when opening another thread. This can silently change the model answering a conversation.

## Decision
Restore the thread provider/model before passive effects run on entry. Within a thread, explicit selections win over provider refreshes. If the saved model is absent, disabled, or disconnected, clear the global selection and show a persistent actionable message instead of choosing a replacement. A library arriving after entry can restore the saved model only while no replacement has been chosen. Chats without a saved model retain startup behavior. Send preserves the draft until an explicit replacement is selected. Asynchronous model switches may publish engine/API state after navigation, but may only update selection, last-used model and thread persistence while the initiating selection and thread still own the request. Existing per-thread persistence and model startup remain responsible for saving and loading the selected model.

## Consequences
No new storage or backend flags. Users choose a replacement or restore the missing model/provider. Cached remote model lists cannot prove network reachability; runtime connection and load failures retain their existing error handling.
