/**
 * The one id of a GenieX model's download (change `add-geniex-runtime`): the Rust task id, each
 * file's `model_id`, the download panel's row and every download event. Tauri takes only
 * `[A-Za-z0-9_-]` in the event name the task id ends up in; the panel names the row from the
 * download's origin, which the card records.
 */

const PREFIX = 'geniex-'

export function geniexDownloadId(modelId: string): string {
  return `${PREFIX}${modelId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

export function isGeniexDownloadId(id: string): boolean {
  return id.startsWith(PREFIX)
}
