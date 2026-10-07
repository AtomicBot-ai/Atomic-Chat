/**
 * TensorRT-LLM Extension (Linux and Windows)
 *
 * NVIDIA's TensorRT-LLM as one more local engine: `atomic-chat-core` runs `trtllm-serve` in a
 * container on one NVIDIA GPU (openspec change `add-tensorrt-llm-linux`; on Windows inside Atomic
 * Chat's own WSL distribution, change `add-tensorrt-llm-windows`). Everything a managed engine's
 * extension does — visibility by the core's plan, the shared model store, loads, deletion through
 * the core — is the shared `managedEngineExtension` (change `add-vllm-runtime`); this file names the
 * engine and hands over this extension's own `@janhq/core` and Tauri functions.
 *
 * Built into the Linux and Windows apps (`build:extensions:linux`, `build:extensions:win32`). On
 * Windows the core hides the provider on ARM and until conf publishes the Windows environment
 * manifest.
 */

import { AIEngine, fs, getJanDataFolderPath, joinPath } from '@janhq/core'
import { info, warn, error as logError } from '@tauri-apps/plugin-log'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { managedEngineExtension } from '../../shared/managed-engine/extension'
import type { Invoke } from '../../shared/atomicCoreRuntime'

export default class TensorrtLlmExtension extends managedEngineExtension(
  { engineId: 'tensorrt-llm', label: 'TensorRT-LLM', settings: () => SETTINGS },
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
