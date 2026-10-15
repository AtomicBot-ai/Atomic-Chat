/**
 * Downloading a Foundry Local variant (openspec change `add-foundry-local`, design D4, spec "Вариант
 * качает клиент из Azure ML registry"). The core never downloads Foundry Local models; the app does,
 * with its own downloader, under one row of the download panel:
 *
 * 1. the core's verdict on the variant (`POST /models/foundry-local/check`): only `ok` downloads —
 *    the card sends the person to the provider page for an engine or accelerator that is missing;
 * 2. resolve: `resolver.url_template` of conf's list, region by region, answers a short-lived SAS
 *    link to the variant's blob container and the variant's `kvTags`;
 * 3. the files: a curated variant's paths, sizes and sha256 come from the list; a catalog variant's
 *    from the container's listing under `kvTags.directoryPath`, checked by size only (as Microsoft's
 *    own client does);
 * 4. one `download_files` task `foundry-local-<variant>`, each file with a `resume_key` that does
 *    not change with the link: a 403 (the link expired) resolves again and calls the downloader
 *    again, which keeps the bytes already on disk;
 * 5. `model.yml` last, with the `foundry_local` block the core loads the variant by. A folder without
 *    it is not a model, so a download that failed or was cut off never lists as one.
 */

import { invoke } from '@tauri-apps/api/core'
import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import { DownloadEvent, events, fs, getJanDataFolderPath } from '@janhq/core'

import { isDownloadCancellationError } from '@/lib/downloadCancellation'
import { foundryLocalDownloadId } from '@/lib/foundry-local/download-id'
import { variantLabel } from '@/lib/foundry-local/hub'
import {
  isTransferValidationError,
  transferFiles,
  type TransferItem,
  type TransferOptions,
} from '@/services/diffusion/transfer'
import { InsufficientModelSpaceError, underRoot } from '@/services/managed-models/models'

import { checkFoundryLocalVariant } from './core'
import type { FoundryLocalList } from './curated'
import type {
  FoundryLocalCheckRequest,
  FoundryLocalCheckResult,
  FoundryLocalHubModel,
  FoundryLocalHubVariant,
} from './types'

/** The variant cannot run here yet: the card leads to the provider page instead. */
export class FoundryLocalNotReadyError extends Error {
  constructor(readonly check: FoundryLocalCheckResult) {
    super(check.reason ?? `Foundry Local cannot run this variant here (${check.verdict}).`)
    this.name = 'FoundryLocalNotReadyError'
  }
}

/** Spec: "источник моделей Foundry Local недоступен" — the resolve endpoint gave no usable link. */
export class FoundryLocalSourceUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`The Foundry Local model source is unavailable: ${detail}`)
    this.name = 'FoundryLocalSourceUnavailableError'
  }
}

/** `FreeSpaceReport` of `src-tauri/src/core/downloads/disk.rs`: the data folder's volume. */
interface FreeSpaceReport {
  available: number | null
  headroom: number
}

export interface FoundryLocalInstallDeps {
  check: (request: FoundryLocalCheckRequest) => Promise<FoundryLocalCheckResult>
  /** A GET answered as text, whatever the status (the resolve endpoint and the blob listing). */
  getText: (url: string) => Promise<{ status: number; text: string }>
  dataFolder: () => Promise<string>
  /** Size of a file (an absolute path), or null when it is not there. */
  existingSize: (savePath: string) => Promise<number | null>
  /** Whether a download of this file left a partial (`<file>.tmp`) behind. */
  hasPartial: (savePath: string) => Promise<boolean>
  freeSpace: () => Promise<FreeSpaceReport | null>
  transfer: (items: TransferItem[], taskId: string, options: TransferOptions) => Promise<void>
  writeYaml: (savePath: string, data: unknown) => Promise<void>
  emit: (event: string, payload: unknown) => void
}

export interface FoundryLocalInstallRequest {
  model: FoundryLocalHubModel
  variant: FoundryLocalHubVariant
  /** conf's list: its resolver. */
  list: FoundryLocalList
  onProgress?: (transferred: number, total: number) => void
}

/** A link that expired gets a fresh one this many times in one install. */
const MAX_RELINKS = 3

type KvTags = Record<string, unknown>

interface Resolved {
  container: string
  query: string
  kvTags: KvTags
}

interface PlannedFile {
  path: string
  size: number
  sha256?: string
}

const isExpiredLink = (error: unknown): boolean =>
  /HTTP status 403\b/.test(error instanceof Error ? error.message : String(error))

/** Ask the regions in order; the first answer with a container link wins. */
async function resolveVariant(
  list: FoundryLocalList,
  assetId: string,
  deps: FoundryLocalInstallDeps
): Promise<Resolved> {
  const failures: string[] = []
  for (const region of list.resolver.regions) {
    const url = list.resolver.url_template
      .replace('{region}', region)
      .replace('{asset_id}', encodeURIComponent(assetId))
    try {
      const { status, text } = await deps.getText(url)
      if (status !== 200) {
        failures.push(`${region}: HTTP ${status}`)
        continue
      }
      const answer = JSON.parse(text) as { blobSasUri?: unknown; modelEntity?: { kvTags?: unknown } }
      const sas = answer.blobSasUri
      if (typeof sas !== 'string' || !sas.startsWith('https://') || !sas.includes('?')) {
        failures.push(`${region}: no container link in the answer`)
        continue
      }
      const [container, query] = sas.split('?', 2)
      const kvTags =
        answer.modelEntity?.kvTags && typeof answer.modelEntity.kvTags === 'object'
          ? (answer.modelEntity.kvTags as KvTags)
          : {}
      return { container: container.replace(/\/+$/, ''), query, kvTags }
    } catch (error) {
      failures.push(`${region}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new FoundryLocalSourceUnavailableError(failures.join('; ') || 'no region to ask')
}

const SAFE_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/
const isSafePath = (path: string) =>
  SAFE_PATH.test(path) && !path.split('/').some((segment) => segment === '.' || segment === '..')

/** The container's blobs under `prefix`, following the listing's markers. */
async function listContainer(
  resolved: Resolved,
  prefix: string,
  deps: FoundryLocalInstallDeps
): Promise<PlannedFile[]> {
  const files: PlannedFile[] = []
  let marker = ''
  for (let page = 0; page < 20; page++) {
    const url =
      `${resolved.container}?${resolved.query}&restype=container&comp=list` +
      (prefix ? `&prefix=${encodeURIComponent(`${prefix}/`)}` : '') +
      (marker ? `&marker=${encodeURIComponent(marker)}` : '')
    const { status, text } = await deps.getText(url)
    if (status !== 200) throw new FoundryLocalSourceUnavailableError(`the file listing answered HTTP ${status}`)
    const xml = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml')
    for (const blob of Array.from(xml.getElementsByTagName('Blob'))) {
      const name = blob.getElementsByTagName('Name')[0]?.textContent ?? ''
      const size = Number(blob.getElementsByTagName('Content-Length')[0]?.textContent)
      const path = prefix && name.startsWith(`${prefix}/`) ? name.slice(prefix.length + 1) : name
      if (prefix && !name.startsWith(`${prefix}/`)) continue
      if (!isSafePath(path) || !Number.isFinite(size) || size <= 0) continue
      files.push({ path, size })
    }
    marker = xml.getElementsByTagName('NextMarker')[0]?.textContent ?? ''
    if (!marker) break
  }
  if (files.length === 0) throw new FoundryLocalSourceUnavailableError('the variant lists no files')
  return files
}

const tagString = (tags: KvTags, key: string): string | undefined =>
  typeof tags[key] === 'string' && (tags[key] as string).length > 0 ? (tags[key] as string) : undefined
const tagBoolean = (tags: KvTags, key: string): boolean | undefined => {
  const value = tagString(tags, key)
  return value === undefined ? undefined : value.toLowerCase() === 'true'
}
const tagNumber = (tags: KvTags, key: string): number | undefined => {
  const value = Number(tagString(tags, key))
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** `model.yml`: the folder, the name, the bytes, and what the host registers the variant with. */
function modelYml(
  model: FoundryLocalHubModel,
  variant: FoundryLocalHubVariant,
  files: PlannedFile[],
  tags: KvTags
): Record<string, unknown> {
  const contextLength = variant.context_length ?? model.context_length ?? tagNumber(tags, 'contextLength')
  const reasoningStart = tagString(tags, 'reasoningStart')
  const reasoningEnd = tagString(tags, 'reasoningEnd')
  return {
    model_path: `foundry-local/models/${variant.id}`,
    name: `${model.name} (${variantLabel(variant)})`,
    size_bytes: files.reduce((total, file) => total + file.size, 0),
    foundry_local: {
      model_id: model.model_id,
      variant_id: variant.id,
      execution_provider: variant.execution_provider,
      device: variant.device,
      asset_id: variant.asset_id,
      asset_version: variant.version,
      ...(contextLength ? { context_length: contextLength } : {}),
      tools: model.tools ?? tagBoolean(tags, 'supportsToolCalling') ?? false,
      reasoning: model.reasoning ?? tagBoolean(tags, 'supportsReasoning') ?? false,
      ...(reasoningStart && reasoningEnd
        ? { reasoning_start: reasoningStart, reasoning_end: reasoningEnd }
        : {}),
    },
  }
}

/** Downloads and records one variant; rejects before any download when it cannot run here. */
export async function installFoundryLocalVariant(
  request: FoundryLocalInstallRequest,
  deps: FoundryLocalInstallDeps = defaultFoundryLocalInstallDeps()
): Promise<{ modelId: string }> {
  const { model, variant, list } = request
  const check = await deps.check({ execution_provider: variant.execution_provider, device: variant.device })
  if (check.verdict !== 'ok') throw new FoundryLocalNotReadyError(check)

  let resolved = await resolveVariant(list, variant.asset_id, deps)
  const prefix = variant.path_prefix ?? tagString(resolved.kvTags, 'directoryPath') ?? ''
  const files: PlannedFile[] = variant.files
    ? variant.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }))
    : await listContainer(resolved, prefix, deps)

  const root = underRoot(await deps.dataFolder(), 'foundry-local', 'models', variant.id)
  const downloadId = foundryLocalDownloadId(variant.id)
  const saved = (file: PlannedFile) => underRoot(root, file.path)
  const pending: PlannedFile[] = []
  for (const file of files) {
    // Complete files are not fetched again; a partial one is resumed by the downloader.
    if ((await deps.existingSize(saved(file))) === file.size) continue
    pending.push(file)
  }
  const needed = pending.reduce((total, file) => total + file.size, 0)
  // A resumed download needs only what its partials lack, which only the downloader can count.
  const resuming = (await Promise.all(pending.map((file) => deps.hasPartial(saved(file))))).some(Boolean)
  const space = await deps.freeSpace()
  if (space?.available != null && !resuming && space.available - space.headroom < needed) {
    throw new InsufficientModelSpaceError(root, needed, Math.max(0, space.available - space.headroom))
  }

  const items = (link: Resolved): TransferItem[] =>
    pending.map((file) => ({
      url: `${link.container}/${prefix ? `${prefix}/` : ''}${file.path}?${link.query}`,
      save_path: saved(file),
      size: file.size,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
      model_id: downloadId,
      resume_key: `foundry-local/${variant.id}/${file.path}`,
    }))

  try {
    for (let relinks = 0; pending.length > 0; relinks++) {
      try {
        await deps.transfer(items(resolved), downloadId, {
          resume: true,
          onProgress: (transferred, total) => {
            // Status-only events (`{ stage }`) carry no bytes; as progress they would rewind the bar.
            if (typeof transferred !== 'number' || typeof total !== 'number') return
            deps.emit(DownloadEvent.onFileDownloadUpdate, {
              modelId: downloadId,
              percent: total > 0 ? transferred / total : 0,
              size: { transferred, total },
              downloadType: 'Model',
            })
            request.onProgress?.(transferred, total)
          },
        })
        break
      } catch (error) {
        if (!isExpiredLink(error) || relinks >= MAX_RELINKS) throw error
        // The SAS link lives a few hours: a fresh one points at the same files, and the
        // resume keys keep what is already on disk.
        resolved = await resolveVariant(list, variant.asset_id, deps)
      }
    }
    // Last: this file turns the folder into a model for the core and the extension.
    await deps.writeYaml(underRoot(root, 'model.yml'), modelYml(model, variant, files, resolved.kvTags))
  } catch (error) {
    if (pending.length > 0) emitDownloadEnded(deps, downloadId, error)
    throw error
  }
  if (pending.length > 0) {
    deps.emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: downloadId,
      downloadType: 'Model',
      size: { transferred: needed, total: needed },
    })
  }
  return { modelId: variant.id }
}

/** End the row and its toasts the way a managed model's download ends them. */
function emitDownloadEnded(deps: FoundryLocalInstallDeps, downloadId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (isDownloadCancellationError(error)) {
    deps.emit(DownloadEvent.onFileDownloadStopped, { modelId: downloadId, downloadType: 'Model' })
  } else if (isTransferValidationError(error)) {
    deps.emit(DownloadEvent.onModelValidationFailed, {
      modelId: downloadId,
      downloadType: 'Model',
      error: message,
      reason: 'validation_failed',
    })
  } else {
    deps.emit(DownloadEvent.onFileDownloadError, { modelId: downloadId, downloadType: 'Model', error: message })
  }
}

export function defaultFoundryLocalInstallDeps(): FoundryLocalInstallDeps {
  return {
    check: checkFoundryLocalVariant,
    getText: async (url) => {
      // Azure answers the webview's origin with no CORS headers: the Tauri HTTP plugin asks it.
      const fetcher = typeof IS_TAURI !== 'undefined' && IS_TAURI ? (fetchTauri as typeof fetch) : fetch
      const response = await fetcher(url, { method: 'GET' })
      return { status: response.status, text: await response.text() }
    },
    dataFolder: getJanDataFolderPath,
    existingSize: async (savePath) => {
      try {
        const stat = await fs.fileStat(savePath)
        return stat && !stat.isDirectory ? Number(stat.size) : null
      } catch {
        return null
      }
    },
    hasPartial: async (savePath) => {
      try {
        return (await fs.fileStat(`${savePath}.tmp`)) != null
      } catch {
        return false
      }
    },
    // The command `downloadPreflight.ts` asks too; an unknown answer leaves the check to the downloader.
    freeSpace: () => invoke<FreeSpaceReport>('get_download_free_space').catch(() => null),
    transfer: transferFiles,
    writeYaml: (savePath, data) => invoke<void>('write_yaml', { data, savePath }),
    emit: (event, payload) => events.emit(event, payload),
  }
}
