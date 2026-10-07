/**
 * vLLM Extension (Linux and Windows)
 *
 * vLLM as a second managed engine (openspec change `add-vllm-runtime`): `atomic-chat-core` runs
 * `vllm serve` in a container on one NVIDIA GPU — on Windows inside Atomic Chat's own WSL
 * distribution — and serves each loaded model on a loopback gateway that checks the session's key.
 * Everything a managed engine's extension does — visibility by the core's plan for `vllm`, the
 * shared model store, loads, deletion through the core — is the shared `managedEngineExtension`;
 * this file names the engine and hands over this extension's own `@janhq/core` and Tauri functions.
 *
 * Built into the Linux and Windows apps (`build:extensions:linux`, `build:extensions:win32`). The
 * core hides the provider until conf publishes `runtimes/vllm.json` (design D15), wherever there is
 * no NVIDIA card, and on Windows on ARM.
 */

import { AIEngine, fs, getJanDataFolderPath, joinPath } from '@janhq/core'
import { info, warn, error as logError } from '@tauri-apps/plugin-log'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { managedEngineExtension } from '../../shared/managed-engine/extension'
import type { Invoke } from '../../shared/atomicCoreRuntime'

export default class VllmExtension extends managedEngineExtension(
  { engineId: 'vllm', label: 'vLLM', settings: () => SETTINGS },
  {
    AIEngine,
    invoke: invoke as Invoke,
    listen: (event, handler) => listen(event, handler),
    fs,
    joinPath,
    getJanDataFolderPath,
    log: { info, warn, error: logError },
  }
) {}
