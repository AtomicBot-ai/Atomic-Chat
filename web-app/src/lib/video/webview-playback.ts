/**
 * What the webview may do with a clip, and how it gets the clip's bytes.
 *
 * WebKitGTK (Linux) plays `<video>` through GStreamer, and its media source
 * (`webkitwebsrc`) reads http, https and blob URLs only. A clip served as
 * `asset://localhost/…` reaches GStreamer with no element to read it ("No
 * URI handler implemented for asset"), and WebKitGTK 2.50.2+ refuses the
 * scheme before that. So on Linux the clip is handed over as a blob: URL of
 * its bytes, read through the paged file command.
 *
 * On a host whose GStreamer could not build a pipeline at all, opening the
 * Video page hung the web process and the whole window with it (Hyprland on
 * Omarchy, 2026-10-15). So on Linux the player is still mounted only once
 * Play is pressed.
 */

import { readFileBytes } from '@/lib/readFileBytes'

/** Whether the page may load clips into the webview without the user asking. */
export const webviewAutoloadsVideo = (): boolean => !IS_LINUX

/** Whether the webview's player can read a clip over the asset protocol. */
export const webviewReadsAssetMedia = (): boolean => !IS_LINUX

/** The largest clip read into memory to play it from a blob: URL. */
export const MAX_BLOB_CLIP_BYTES = 512 * 1024 * 1024

/** The media type of a gallery clip, by its container. */
export const clipMediaType = (path: string): string =>
  /\.mp4$/i.test(path) ? 'video/mp4' : 'video/webm'

/**
 * Whether the webview says it can decode the clip. WebKitGTK answers from the
 * GStreamer registry without building a pipeline, so a host missing the
 * demuxer is caught here instead of failing in the player.
 */
export const webviewCanPlay = (path: string): boolean =>
  document.createElement('video').canPlayType(clipMediaType(path)) !== ''

/** A blob: URL of the clip's bytes. The caller revokes it. */
export async function clipBlobUrl(
  path: string,
  maxBytes = MAX_BLOB_CLIP_BYTES
): Promise<string> {
  const { bytes } = await readFileBytes(path, { maxBytes })
  return URL.createObjectURL(new Blob([bytes], { type: clipMediaType(path) }))
}
