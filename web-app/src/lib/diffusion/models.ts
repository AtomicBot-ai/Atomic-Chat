/**
 * Diffusion checkpoints on disk: planning, downloading, listing, deleting,
 * and turning a catalog entry into the plugin's load request.
 *
 * An *artifact* is one family + one quant (`z-image:q4_k_m`). Its transformer
 * lives under `<modelsRoot>/<family>/`, its side files (VAE, text encoders)
 * under `<modelsRoot>/shared/<owner>--<repo>/`, so the 8 GB Qwen3 text encoder
 * that Z-Image and FLUX.2 Klein both use is downloaded once and shared.
 *
 * Downloads go through the ordinary download pipeline (`services/diffusion/
 * transfer.ts`), never through the plugin, which is only ever handed the
 * resolved absolute paths at load time. The planning functions are pure so
 * the de-duplication and the "already on disk" logic can be tested directly.
 */

import { getServiceHub } from '@/hooks/useServiceHub'
import {
  DIFFUSION_SHARED_DIR,
  getDiffusionPaths,
  joinDiffusionPath,
} from '@/lib/diffusion/config'
import {
  DIFFUSION_FAMILY_IDS,
  findQuant,
  type DiffusionCatalog,
  type DiffusionCatalogFamily,
  type DiffusionCatalogFile,
  type DiffusionCatalogQuant,
} from '@/services/diffusion-catalog-registry'
import {
  cancelTransfer,
  downloadProxyConfig,
  emitTransferError,
  emitTransferProgress,
  emitTransferSuccess,
  sanitizeTaskId,
  transferFiles,
  type TransferItem,
} from '@/services/diffusion/transfer'
import type {
  DiffusionEngineId,
  DiffusionFamilyId,
  DiffusionModelFile,
  DiffusionModelFiles,
  DiffusionOffloadPolicy,
  LoadDiffusionModelRequest,
} from '@/services/diffusion/types'

export type DiffusionArtifactEntryKind = 'transformer' | 'vae' | 'text_encoder'

export type DiffusionArtifactEntry = {
  kind: DiffusionArtifactEntryKind
  repo: string
  /** Path inside the repo, as the catalog spells it. */
  filename: string
  url: string
  bytes: number
  sha256?: string
  /** Text encoders only. */
  field?: DiffusionCatalogFile['field']
  /** `/`-separated path below the models root; what `DiffusionModelFile.relativePath` reports. */
  relativePath: string
  /** Absolute save path below `modelsRoot`. */
  savePath: string
  /** A listed file with the same relative path and the same byte count. */
  present: boolean
}

export type DiffusionArtifactPlan = {
  artifactId: string
  family: DiffusionFamilyId
  quantId: string
  entries: DiffusionArtifactEntry[]
  totalBytes: number
  missingBytes: number
}

export type InstalledArtifact = {
  id: string
  family: DiffusionFamilyId
  quantId: string
  /** Total on-disk footprint the artifact needs, shared files included. */
  bytes: number
  complete: boolean
  /** Relative paths still missing; empty when `complete`. */
  missing: string[]
}

const TASK_ID_PREFIX = 'diffusion-model-'

export function artifactId(family: string, quantId: string): string {
  return `${family}:${quantId}`
}

export function parseArtifactId(
  id: string
): { family: DiffusionFamilyId; quantId: string } | null {
  const separator = id.indexOf(':')
  if (separator <= 0 || separator === id.length - 1) return null
  const family = id.slice(0, separator)
  const quantId = id.slice(separator + 1)
  if (!(DIFFUSION_FAMILY_IDS as readonly string[]).includes(family)) return null
  return { family: family as DiffusionFamilyId, quantId }
}

/** Download-panel row id; dots and colons collapse to `_` for Tauri's event alphabet. */
export function diffusionDownloadTaskId(artifact: string): string {
  return `${TASK_ID_PREFIX}${sanitizeTaskId(artifact)}`
}

/** `unsloth/Z-Image-Turbo-ComfyUI` → `unsloth--Z-Image-Turbo-ComfyUI`. */
export function sharedRepoDir(repo: string): string {
  return repo.replace(/\//g, '--')
}

export function hfResolveUrl(repo: string, filename: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${filename}`
}

const basenameOf = (filename: string): string =>
  filename.split('/').filter((s) => s.length > 0).pop() ?? filename

const normalizeRelative = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^\/+/, '')

const isPresent = (
  files: DiffusionModelFile[],
  relativePath: string,
  savePath: string,
  bytes: number
): boolean =>
  files.some(
    (file) =>
      file.bytes === bytes &&
      (normalizeRelative(file.relativePath) === relativePath ||
        file.path === savePath)
  )

/**
 * Everything one artifact needs on disk, with what is already there marked.
 * Pure. Throws for a quant the family does not list.
 */
export function planArtifactDownload(
  family: DiffusionCatalogFamily,
  quantId: string,
  files: DiffusionModelFile[],
  modelsRoot: string
): DiffusionArtifactPlan {
  const quant = findQuant(family, quantId)
  if (!quant) {
    throw new Error(`Family ${family.id} has no quant "${quantId}"`)
  }

  const entries: DiffusionArtifactEntry[] = []
  const seen = new Set<string>()
  const push = (
    kind: DiffusionArtifactEntryKind,
    file: DiffusionCatalogFile,
    relativePath: string
  ) => {
    // The same repo file listed twice within one family is one download.
    if (seen.has(relativePath)) return
    seen.add(relativePath)
    const savePath = joinDiffusionPath(modelsRoot, relativePath)
    entries.push({
      kind,
      repo: file.repo,
      filename: file.filename,
      url: hfResolveUrl(file.repo, file.filename),
      bytes: file.bytes,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
      ...(file.field ? { field: file.field } : {}),
      relativePath,
      savePath,
      present: isPresent(files, relativePath, savePath, file.bytes),
    })
  }

  push(
    'transformer',
    {
      repo: family.transformer.repo,
      filename: quant.filename,
      bytes: quant.bytes,
      ...(quant.sha256 ? { sha256: quant.sha256 } : {}),
    },
    `${family.id}/${basenameOf(quant.filename)}`
  )
  if (family.vae) {
    push(
      'vae',
      family.vae,
      `${DIFFUSION_SHARED_DIR}/${sharedRepoDir(family.vae.repo)}/${basenameOf(family.vae.filename)}`
    )
  }
  for (const encoder of family.text_encoders) {
    push(
      'text_encoder',
      encoder,
      `${DIFFUSION_SHARED_DIR}/${sharedRepoDir(encoder.repo)}/${basenameOf(encoder.filename)}`
    )
  }

  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0)
  const missingBytes = entries
    .filter((e) => !e.present)
    .reduce((sum, e) => sum + e.bytes, 0)
  return {
    artifactId: artifactId(family.id, quantId),
    family: family.id,
    quantId,
    entries,
    totalBytes,
    missingBytes,
  }
}

/**
 * Every artifact whose transformer is on disk, complete or not. Pure: matched
 * on relative paths, so no models root is needed.
 */
export function listInstalledArtifacts(
  catalog: DiffusionCatalog,
  files: DiffusionModelFile[]
): InstalledArtifact[] {
  const installed: InstalledArtifact[] = []
  for (const family of catalog.families) {
    for (const quant of family.transformer.quants) {
      const plan = planArtifactDownload(family, quant.id, files, '')
      const transformer = plan.entries.find((e) => e.kind === 'transformer')
      if (!transformer?.present) continue
      const missing = plan.entries
        .filter((e) => !e.present)
        .map((e) => e.relativePath)
      installed.push({
        id: plan.artifactId,
        family: family.id,
        quantId: quant.id,
        bytes: plan.totalBytes,
        complete: missing.length === 0,
        missing,
      })
    }
  }
  return installed
}

/**
 * Which listed files removing an artifact frees, and which shared files stay
 * because another *installed* artifact still needs them. Pure.
 */
export function planArtifactDeletion(
  family: DiffusionCatalogFamily,
  quantId: string,
  files: DiffusionModelFile[],
  catalog: DiffusionCatalog
): { remove: DiffusionModelFile[]; kept: DiffusionModelFile[] } {
  const plan = planArtifactDownload(family, quantId, files, '')
  const target = artifactId(family.id, quantId)

  const stillNeeded = new Set<string>()
  for (const other of listInstalledArtifacts(catalog, files)) {
    if (other.id === target) continue
    const otherFamily = catalog.families.find((f) => f.id === other.family)
    if (!otherFamily) continue
    for (const entry of planArtifactDownload(
      otherFamily,
      other.quantId,
      files,
      ''
    ).entries) {
      if (entry.kind !== 'transformer') stillNeeded.add(entry.relativePath)
    }
  }

  const remove: DiffusionModelFile[] = []
  const kept: DiffusionModelFile[] = []
  for (const entry of plan.entries) {
    if (!entry.present) continue
    const file = files.find(
      (f) => normalizeRelative(f.relativePath) === entry.relativePath
    )
    if (!file) continue
    if (entry.kind !== 'transformer' && stillNeeded.has(entry.relativePath)) {
      kept.push(file)
    } else {
      remove.push(file)
    }
  }
  return { remove, kept }
}

/**
 * Delete an artifact's files through the plugin (which only ever deletes
 * below the models root). A shared side file survives while another
 * installed artifact still needs it.
 */
export async function deleteArtifact(
  family: DiffusionCatalogFamily,
  quantId: string,
  files: DiffusionModelFile[],
  catalog: DiffusionCatalog
): Promise<{ removed: string[]; kept: string[] }> {
  const { remove, kept } = planArtifactDeletion(family, quantId, files, catalog)
  const diffusion = getServiceHub().diffusion()
  const removed: string[] = []
  for (const file of remove) {
    await diffusion.deleteModelFile(file.path)
    removed.push(file.path)
  }
  return { removed, kept: kept.map((file) => file.path) }
}

const absolutePathOf = (
  entry: DiffusionArtifactEntry,
  files: DiffusionModelFile[]
): string =>
  files.find(
    (file) => normalizeRelative(file.relativePath) === entry.relativePath
  )?.path ?? entry.savePath

/**
 * The plugin's load request for an artifact. Pure. Side files map by their
 * catalog `field` onto the sd-cli flag slots; family defaults and ranges are
 * carried along so the plugin can validate requests without the catalog.
 */
export function buildLoadRequest(
  family: DiffusionCatalogFamily,
  quantId: string,
  files: DiffusionModelFile[],
  modelsRoot: string,
  opts: {
    offload: DiffusionOffloadPolicy
    engine?: DiffusionEngineId
    threads?: number
    startupTimeoutSecs?: number
  }
): LoadDiffusionModelRequest {
  const quant = findQuant(family, quantId) as DiffusionCatalogQuant
  const plan = planArtifactDownload(family, quantId, files, modelsRoot)
  const transformer = plan.entries.find((e) => e.kind === 'transformer')
  if (!transformer) {
    throw new Error(`Family ${family.id} has no quant "${quantId}"`)
  }

  const modelFiles: DiffusionModelFiles = {
    diffusionModel: absolutePathOf(transformer, files),
  }
  for (const entry of plan.entries) {
    if (entry.kind === 'vae') {
      modelFiles.vae = absolutePathOf(entry, files)
      if (family.vae_format) modelFiles.vaeFormat = family.vae_format
    } else if (entry.kind === 'text_encoder') {
      const path = absolutePathOf(entry, files)
      switch (entry.field) {
        case 'llm':
          modelFiles.llm = path
          break
        case 'qwen2vl':
          modelFiles.qwen2vl = path
          break
        case 'clip_l':
          modelFiles.clipL = path
          break
        case 't5xxl':
          modelFiles.t5xxl = path
          break
      }
    }
  }

  const { defaults, ranges } = family
  return {
    modelId: plan.artifactId,
    family: family.id,
    modality: family.modality,
    displayName: `${family.name} ${quant.label}`,
    files: modelFiles,
    defaults: {
      steps: defaults.steps,
      cfgScale: defaults.cfg_scale,
      ...(defaults.guidance !== undefined ? { guidance: defaults.guidance } : {}),
      ...(defaults.sampling_method
        ? { samplingMethod: defaults.sampling_method }
        : {}),
      ...(defaults.flow_shift !== undefined
        ? { flowShift: defaults.flow_shift }
        : {}),
      width: defaults.width,
      height: defaults.height,
    },
    ranges: {
      steps: [ranges.steps[0], ranges.steps[1]],
      dims: [ranges.dims[0], ranges.dims[1]],
      dimMultiple: ranges.dim_multiple,
    },
    offload: opts.offload,
    ...(opts.engine ? { engine: opts.engine } : {}),
    ...(opts.threads !== undefined ? { threads: opts.threads } : {}),
    ...(opts.startupTimeoutSecs !== undefined
      ? { startupTimeoutSecs: opts.startupTimeoutSecs }
      : {}),
  }
}

export type DownloadArtifactOptions = {
  hfToken?: string
  resume?: boolean
  onProgress?: (progress: { transferred: number; total: number }) => void
}

/**
 * Download whatever an artifact is still missing. The download panel shows
 * the transfer under `diffusionDownloadTaskId(artifactId)`. Resolves to the
 * plan that was executed (every entry present when it returns).
 */
export async function downloadArtifact(
  family: DiffusionCatalogFamily,
  quantId: string,
  opts: DownloadArtifactOptions = {}
): Promise<DiffusionArtifactPlan> {
  const diffusion = getServiceHub().diffusion()
  const { modelsRoot } = await getDiffusionPaths()
  const files = await diffusion.listModelFiles()
  const plan = planArtifactDownload(family, quantId, files, modelsRoot)
  const missing = plan.entries.filter((entry) => !entry.present)
  if (missing.length === 0) return plan

  const taskId = diffusionDownloadTaskId(plan.artifactId)
  const proxy = downloadProxyConfig()
  const items: TransferItem[] = missing.map((entry) => ({
    url: entry.url,
    save_path: entry.savePath,
    ...(proxy ? { proxy } : {}),
    ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
    size: entry.bytes,
    model_id: taskId,
  }))

  try {
    emitTransferProgress(taskId, 'Model', 0, plan.missingBytes)
    await transferFiles(items, taskId, {
      resume: opts.resume ?? false,
      ...(opts.hfToken ? { hfToken: opts.hfToken } : {}),
      onProgress: (transferred, total) => {
        opts.onProgress?.({ transferred, total })
        emitTransferProgress(taskId, 'Model', transferred, total)
      },
    })
    emitTransferSuccess(taskId, 'Model', plan.missingBytes)
  } catch (error) {
    emitTransferError(taskId, 'Model', error)
    throw error
  }

  return {
    ...plan,
    entries: plan.entries.map((entry) => ({ ...entry, present: true })),
    missingBytes: 0,
  }
}

export async function cancelArtifactDownload(artifact: string): Promise<void> {
  await cancelTransfer(diffusionDownloadTaskId(artifact))
}
