/**
 * The one id of a LiteRT-LM variant's download (change `add-litert-lm-runtime`): the Rust task id,
 * the file's `model_id`, the download panel's row and every download event. Tauri takes only
 * `[A-Za-z0-9_-]` in the event name the task id ends up in; the panel names the row from the
 * download's origin, which the card records.
 */

const PREFIX = 'litert-lm-'

export function liteRtLmDownloadId(variantId: string): string {
  return `${PREFIX}${variantId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

export function isLiteRtLmDownloadId(id: string): boolean {
  return id.startsWith(PREFIX)
}
