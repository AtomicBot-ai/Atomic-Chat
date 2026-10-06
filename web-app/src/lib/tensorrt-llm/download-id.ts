/**
 * The one id of a TensorRT-LLM model's download (change `add-tensorrt-llm-model-hub`, design D6):
 * the Rust task id, each file's `model_id`, the download panel's row and every download event.
 * Tauri takes only `[A-Za-z0-9_-]` in the event name the task id ends up in, so the repository
 * cannot be read back from it; the panel names the row from the download's origin.
 */

const PREFIX = 'tensorrt-llm-'

export function tensorrtDownloadId(repository: string): string {
  return `${PREFIX}${repository.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

export function isTensorrtDownloadId(id: string): boolean {
  return id.startsWith(PREFIX)
}
