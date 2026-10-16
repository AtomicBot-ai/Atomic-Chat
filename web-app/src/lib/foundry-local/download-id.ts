/**
 * The one id of a Foundry Local variant's download (change `add-foundry-local`, design D4): the Rust
 * task id, each file's `model_id`, the download panel's row and every download event. Tauri takes
 * only `[A-Za-z0-9_-]` in the event name the task id ends up in; the panel names the row from the
 * download's origin, which the card records.
 */

const PREFIX = 'foundry-local-'

export function foundryLocalDownloadId(variantId: string): string {
  return `${PREFIX}${variantId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

export function isFoundryLocalDownloadId(id: string): boolean {
  return id.startsWith(PREFIX)
}
