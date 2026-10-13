/**
 * Asset materialisation: a finished job's outputs to files on disk, with the
 * provenance needed to answer "how did I make this?" six weeks later.
 *
 * `MediaOutputRef` has exactly three variants and the handling is identical for
 * every provider, which is precisely why the contract keeps materialisation off
 * the adapter (see `contract/jobs.ts`). This module is that single place.
 *
 * Two rules drive the shape of everything here:
 *
 *  - **The data folder is never hardcoded.** It comes from
 *    `AppConfiguration.data_folder`, injected. There are three legacy Windows
 *    APPDATA locations documented in DEVELOP.md, and picking one would be wrong
 *    on some installs and right by accident on others.
 *  - **A half-written file must never become a library entry.** Bytes go to a
 *    `.partial` and are promoted by rename, the same pattern
 *    `jan_utils::backend_bundle` uses for backend archives. A failed write
 *    cleans up after itself.
 *
 * Filesystem access goes through the `MediaFileSystem` port rather than
 * `@janhq/core`'s `fs` directly, so the whole module is testable without a
 * disk and without Tauri.
 */

import { MEDIA_CONTRACT_VERSION } from './contract'
import type {
  MediaJobSnapshot,
  MediaOutputMediaType,
  MediaOutputRef,
  MediaTaskId,
  NormalizedMediaRequest,
} from './contract'

/**
 * Per-asset ceiling. A provider that streams a corrupt or unbounded response
 * should not be able to fill the user's disk one generation at a time.
 */
export const MEDIA_ASSET_MAX_BYTES = 512 * 1024 * 1024

/** The library index and its files live under `<data_folder>/media/`. */
export const MEDIA_FOLDER = 'media'

export type MediaAssetProvenance = {
  provider_id: string
  model_id: string
  model_label: string
  task: MediaTaskId
  params: Record<string, unknown>
  /** Only when it is actually known. See `resolvedSeed` below. */
  resolved_seed?: number
  device?: string
  app_version: string
  contract_version: number
}

export type MediaAsset = {
  /** ULID. */
  asset_id: string
  client_job_id: string
  media_type: MediaOutputMediaType
  /** Absolute. Under `<data_folder>/media/outputs/` unless adopted in place. */
  path: string
  thumb_path?: string
  mime: string
  bytes: number
  width?: number
  height?: number
  duration_ms?: number
  created_at: number
  favourite?: boolean
  /** A name the user gave it. Display only; the file on disk is untouched. */
  name?: string
  provenance: MediaAssetProvenance
}

/** The filesystem operations materialisation needs, and nothing more. */
export type MediaFileSystem = {
  join(...parts: string[]): string
  mkdir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  readText(path: string): Promise<string>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  size(path: string): Promise<number>
}

export type MaterializeContext = {
  request: NormalizedMediaRequest
  model_label: string
  app_version: string
}

export type MaterializeDeps = {
  fs: MediaFileSystem
  /** `AppConfiguration.data_folder`. Never assumed. */
  dataFolder: () => Promise<string>
  /**
   * A folder the user chose for generated files, if any. When it returns a
   * path, outputs are written there under readable names instead of under
   * `<data_folder>/media/outputs/`. The index and thumbnails stay in the data
   * folder either way.
   */
  outputFolder?: () => Promise<string | undefined>
  fetchBytes: (url: string) => Promise<{ bytes: Uint8Array; mime?: string }>
  now: () => number
  newId: () => string
  /** Optional and always non-fatal. Returns the thumbnail's bytes. */
  thumbnail?: (
    asset: Omit<MediaAsset, 'thumb_path'>,
    bytes: Uint8Array | undefined
  ) => Promise<Uint8Array | undefined>
  maxBytes?: number
}

// --- mime ---------------------------------------------------------------------

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
  'model/gltf-binary': 'glb',
}

function mediaTypeOf(mime: string): MediaOutputMediaType {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('model/')) return 'model3d'
  // Renders a download affordance rather than a player that cannot work.
  return 'unknown'
}

function extensionOf(mime: string, path?: string): string {
  const known = EXTENSION_BY_MIME[mime]
  if (known) return known
  const fromPath = path?.split('?')[0]?.split('.').pop()?.toLowerCase()
  if (fromPath && /^[a-z0-9]{1,5}$/.test(fromPath)) return fromPath
  return 'bin'
}

function mimeOfPath(path: string, declared?: string): string {
  if (declared) return declared
  const extension = path.split('?')[0]?.split('.').pop()?.toLowerCase()
  const found = Object.entries(EXTENSION_BY_MIME).find(
    ([, value]) => value === extension
  )
  return found?.[0] ?? 'application/octet-stream'
}

/** Characters Windows, macOS and Linux all accept in a file name. */
function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .toLowerCase() || 'media'
  )
}

/**
 * A readable file name for an asset, e.g. `flux-schnell-20260909-142501.png`.
 *
 * Used for files written to a user-chosen folder and as the default in the
 * "Save as" dialog, so a generation is recognisable outside the app instead of
 * being a bare ULID.
 */
export function suggestedFileName(
  asset: Pick<MediaAsset, 'name' | 'created_at' | 'mime' | 'path'> & {
    provenance: Pick<MediaAssetProvenance, 'model_label'>
  }
): string {
  const date = new Date(asset.created_at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  const base = asset.name?.trim()
    ? slugify(asset.name)
    : `${slugify(asset.provenance.model_label)}-${stamp}`
  return `${base}.${extensionOf(asset.mime, asset.path)}`
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * The seed only if the caller actually chose it.
 *
 * When a seed is left blank the contract says the provider picks one, and
 * `MediaJobSnapshot` gives it nowhere to report what it picked. So for those
 * jobs the seed is genuinely unknown, and recording a 0 - or the absent value -
 * would make "re-run identically" quietly produce a different image. Tracked as
 * decision D8.
 */
function resolvedSeed(params: Record<string, unknown>): number | undefined {
  const seed = params.seed
  return typeof seed === 'number' && Number.isFinite(seed) ? seed : undefined
}

// --- materialisation ----------------------------------------------------------

/** Write bytes through a `.partial`, promoting only on success. */
async function writeAtomic(
  fs: MediaFileSystem,
  path: string,
  bytes: Uint8Array
): Promise<void> {
  const partial = `${path}.partial`
  try {
    await fs.writeBytes(partial, bytes)
    await fs.rename(partial, path)
  } catch (error) {
    // Best effort: the write may never have created the file. What matters is
    // that a `.partial` is never left looking like a real asset.
    await fs.remove(partial).catch(() => undefined)
    throw error
  }
}

async function assetFrom(
  ref: MediaOutputRef,
  context: MaterializeContext,
  deps: MaterializeDeps,
  root: string
): Promise<MediaAsset> {
  const { fs } = deps
  const assetId = deps.newId()
  const createdAt = deps.now()
  const maxBytes = deps.maxBytes ?? MEDIA_ASSET_MAX_BYTES

  const provenance: MediaAssetProvenance = {
    provider_id: context.request.provider_id,
    model_id: context.request.model_id,
    model_label: context.model_label,
    task: context.request.task,
    params: { ...context.request.params },
    ...(resolvedSeed(context.request.params) !== undefined
      ? { resolved_seed: resolvedSeed(context.request.params) }
      : {}),
    ...(context.request.device ? { device: context.request.device } : {}),
    app_version: context.app_version,
    contract_version: MEDIA_CONTRACT_VERSION,
  }

  // A file the provider already wrote is adopted where it lies. Copying would
  // double the disk cost of every local generation and buy nothing.
  if (ref.kind === 'local_path') {
    const mime = mimeOfPath(ref.path, ref.mime)
    return {
      asset_id: assetId,
      client_job_id: context.request.client_job_id,
      media_type: mediaTypeOf(mime),
      path: ref.path,
      mime,
      bytes: await fs.size(ref.path).catch(() => 0),
      created_at: createdAt,
      provenance,
    }
  }

  const { bytes, mime } =
    ref.kind === 'inline'
      ? { bytes: decodeBase64(ref.base64), mime: ref.mime }
      : await deps
          .fetchBytes(ref.url)
          .then((result) => ({
            bytes: result.bytes,
            mime: ref.mime ?? result.mime ?? mimeOfPath(ref.url),
          }))

  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `Asset is too large: ${bytes.byteLength} bytes exceeds the ${maxBytes}-byte ceiling.`
    )
  }

  const extension = extensionOf(mime, ref.kind === 'url' ? ref.url : undefined)
  const chosenFolder = await deps.outputFolder?.().catch(() => undefined)

  let path: string
  if (chosenFolder) {
    // The user's own folder: a readable name, with the id's tail so two
    // generations in the same second can never overwrite one another.
    await fs.mkdir(chosenFolder)
    const readable = suggestedFileName({
      created_at: createdAt,
      mime,
      path: `x.${extension}`,
      provenance: { model_label: context.model_label },
    })
    const dot = readable.lastIndexOf('.')
    path = fs.join(
      chosenFolder,
      `${readable.slice(0, dot)}-${assetId.slice(-6).toLowerCase()}${readable.slice(dot)}`
    )
  } else {
    const date = new Date(createdAt)
    const year = String(date.getUTCFullYear())
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const directory = fs.join(root, 'outputs', year, month)
    await fs.mkdir(directory)
    path = fs.join(directory, `${assetId}.${extension}`)
  }
  await writeAtomic(fs, path, bytes)

  const asset: Omit<MediaAsset, 'thumb_path'> = {
    asset_id: assetId,
    client_job_id: context.request.client_job_id,
    media_type: mediaTypeOf(mime),
    path,
    mime,
    bytes: bytes.byteLength,
    created_at: createdAt,
    provenance,
  }

  const thumbPath = await makeThumbnail(asset, bytes, deps, root)
  return thumbPath ? { ...asset, thumb_path: thumbPath } : asset
}

/**
 * Thumbnailing is a convenience and is never allowed to cost the user their
 * generation. Any failure - no canvas, an unsupported codec, a full disk -
 * leaves the asset saved and the thumbnail absent.
 */
async function makeThumbnail(
  asset: Omit<MediaAsset, 'thumb_path'>,
  bytes: Uint8Array,
  deps: MaterializeDeps,
  root: string
): Promise<string | undefined> {
  if (!deps.thumbnail) return undefined
  try {
    const thumb = await deps.thumbnail(asset, bytes)
    if (!thumb) return undefined
    const directory = deps.fs.join(root, 'thumbs')
    await deps.fs.mkdir(directory)
    const path = deps.fs.join(directory, `${asset.asset_id}.webp`)
    await writeAtomic(deps.fs, path, thumb)
    return path
  } catch {
    return undefined
  }
}

/**
 * A finished job's outputs to assets on disk.
 *
 * Sequential rather than parallel: a batch of eight videos fetched at once
 * would compete for the same disk and the same network, and the ceiling check
 * is per asset.
 */
export async function materialize(
  snapshot: MediaJobSnapshot,
  context: MaterializeContext,
  deps: MaterializeDeps
): Promise<MediaAsset[]> {
  const refs = snapshot.outputs ?? []
  if (refs.length === 0) return []

  const root = deps.fs.join(await deps.dataFolder(), MEDIA_FOLDER)
  const assets: MediaAsset[] = []
  for (const ref of refs) {
    assets.push(await assetFrom(ref, context, deps, root))
  }
  return assets
}

// --- thumbnails ---------------------------------------------------------------

/** Longest edge of a generated thumbnail, in pixels. */
export const MEDIA_THUMB_MAX_EDGE = 512

/**
 * A thumbnailer for a real browser: canvas downscale to WebP for images, and a
 * first-frame capture through a detached `<video>` for video.
 *
 * Deliberately built as a factory that returns a `MaterializeDeps['thumbnail']`
 * rather than being called directly, so the caller can pass nothing at all in
 * an environment that has no canvas - which is every test environment here,
 * because jsdom implements neither `HTMLCanvasElement.toBlob` nor video
 * decoding. Its FAILURE path is covered (`materialize` keeps the asset when
 * thumbnailing throws); the canvas path itself is only exercised in the real
 * app. Recorded as such in the tracker against T08-S05.
 *
 * Everything runs off a blob URL and revokes it, so nothing is left holding a
 * reference to a several-hundred-megabyte video.
 */
export function createBrowserThumbnailer(): NonNullable<
  MaterializeDeps['thumbnail']
> {
  return async (asset, bytes) => {
    if (!bytes || (asset.media_type !== 'image' && asset.media_type !== 'video')) {
      return undefined
    }

    // Copied into a fresh ArrayBuffer: a Uint8Array may be backed by a
    // SharedArrayBuffer, which is not a valid BlobPart.
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    const url = URL.createObjectURL(new Blob([buffer], { type: asset.mime }))
    try {
      const source =
        asset.media_type === 'image'
          ? await loadImage(url)
          : await loadVideoFrame(url)

      const scale = Math.min(
        1,
        MEDIA_THUMB_MAX_EDGE / Math.max(source.width, source.height)
      )
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(source.width * scale))
      canvas.height = Math.max(1, Math.round(source.height * scale))

      const context = canvas.getContext('2d')
      if (!context) return undefined
      context.drawImage(source.element, 0, 0, canvas.width, canvas.height)

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', 0.8)
      )
      if (!blob) return undefined
      return new Uint8Array(await blob.arrayBuffer())
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

type ThumbSource = {
  element: CanvasImageSource
  width: number
  height: number
}

function loadImage(url: string): Promise<ThumbSource> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () =>
      resolve({
        element: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
      })
    image.onerror = () => reject(new Error('The image could not be decoded.'))
    image.src = url
  })
}

function loadVideoFrame(url: string): Promise<ThumbSource> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    // Seeking a little way in avoids the black first frame many encoders emit.
    video.onloadeddata = () => {
      video.currentTime = Math.min(0.1, video.duration || 0)
    }
    video.onseeked = () =>
      resolve({
        element: video,
        width: video.videoWidth,
        height: video.videoHeight,
      })
    video.onerror = () => reject(new Error('The video could not be decoded.'))
    video.src = url
  })
}
