/**
 * What the Downloads page reads off the disk, where no owner keeps a record of
 * it:
 *
 * - the size of an MLX model whose `model.yml` says `size_bytes: 0` — the MLX
 *   download is never handed a size, so every Hub download records none;
 * - the speculative-decoding drafts MLX caches under `mlx/draft-models/` (and a
 *   draft repo imported into `mlx/models/`), which no model list names;
 * - the partial files a download that never finished left behind: the Rust
 *   downloader writes `<file>.tmp`, `.url`, `.parts` and `.parts.new` beside the
 *   file it fetches (`sidecar_path` in `src-tauri/src/core/downloads`).
 *
 * Everything is read with the data folder's own file commands (`readdirSync`,
 * `fileStat`) from roots inside it, and removed with `rm`, which refuses any path
 * outside the data folder. Reading builds a plain tree; the rules below are pure
 * functions over it.
 */

import { fs } from '@janhq/core'

/** Both llama.cpp providers and PrismML read one models directory. */
export const LLAMACPP_MODELS_ROOT = 'llamacpp/models'
export const MLX_MODELS_ROOT = 'mlx/models'
/** Where the MLX extension caches the drafts it downloads (`getDraftRoot`). */
export const MLX_DRAFTS_ROOT = 'mlx/draft-models'

export type DownloadRoot =
  | typeof LLAMACPP_MODELS_ROOT
  | typeof MLX_MODELS_ROOT
  | typeof MLX_DRAFTS_ROOT

/** The sidecars the downloader keeps beside a file it is still fetching. */
export const PARTIAL_SUFFIXES = ['.tmp', '.url', '.parts', '.parts.new']

/** Deeper than any model layout (`<root>/<org>/<repo>/<quant>`); a guard against link loops. */
const MAX_DEPTH = 8

export type DiskFile = { path: string; name: string; bytes: number }

export type DiskDir = {
  /** Absolute, as the data folder's `readdirSync` returns it. */
  path: string
  name: string
  files: DiskFile[]
  dirs: DiskDir[]
  /** Subfolders past the depth limit were not read: the folder is not known whole. */
  truncated?: boolean
}

export type PartialDownload = {
  root: DownloadRoot
  /** The folder under its root, `/`-separated: the model id the download wrote it for. */
  id: string
  /**
   * What removal deletes: the whole folder when no model was ever installed in it,
   * otherwise only the partial files beside the installed one.
   */
  paths: string[]
  bytes: number
}

export type MlxDraft = {
  /** The draft repo (`z-lab/Qwen3.5-4B-DFlash`), or the folder it was imported as. */
  id: string
  path: string
  bytes: number
}

export type DownloadsDiskScan = {
  /** MLX model id → bytes of its folder, for the models whose `model.yml` records no size. */
  mlxModelBytes: Record<string, number>
  partials: PartialDownload[]
  drafts: MlxDraft[]
}

export const EMPTY_DISK_SCAN: DownloadsDiskScan = {
  mlxModelBytes: {},
  partials: [],
  drafts: [],
}

const baseName = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path

export const isPartialFile = (name: string): boolean =>
  PARTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix))

/** Weight files: a folder holding none is an import that points elsewhere. */
const isWeightsFile = (name: string): boolean =>
  /\.(safetensors|gguf|npz)$/i.test(name)

/**
 * Read a folder into a tree. A folder that cannot be read (missing, no
 * permission) reads as empty rather than failing the page; `null` when the root
 * itself is not there.
 */
export async function readDiskTree(
  path: string,
  depth = MAX_DEPTH
): Promise<DiskDir | null> {
  let entries: string[]
  try {
    entries = ((await fs.readdirSync(path)) as string[] | undefined) ?? []
  } catch {
    return null
  }
  const dir: DiskDir = { path, name: baseName(path), files: [], dirs: [] }
  const stats = await Promise.all(
    entries.map(async (entry) => {
      try {
        return { entry, stat: await fs.fileStat(entry) }
      } catch {
        return { entry, stat: undefined }
      }
    })
  )
  const subdirs: string[] = []
  for (const { entry, stat } of stats) {
    if (!stat) continue
    if (stat.isDirectory) subdirs.push(entry)
    else
      dir.files.push({ path: entry, name: baseName(entry), bytes: stat.size })
  }
  if (subdirs.length > 0 && depth <= 0) {
    dir.truncated = true
    return dir
  }
  const children = await Promise.all(
    subdirs.map((subdir) => readDiskTree(subdir, depth - 1))
  )
  for (const child of children) if (child) dir.dirs.push(child)
  return dir
}

/** Bytes of every file under `dir`; with `skipPartials`, without the downloader's sidecars. */
export function treeBytes(dir: DiskDir, skipPartials = false): number {
  let total = 0
  for (const file of dir.files) {
    if (skipPartials && isPartialFile(file.name)) continue
    total += file.bytes
  }
  for (const child of dir.dirs) total += treeBytes(child, skipPartials)
  return total
}

const someInTree = (dir: DiskDir, test: (file: DiskFile) => boolean): boolean =>
  dir.files.some(test) || dir.dirs.some((d) => someInTree(d, test))

/** A model was installed somewhere in this folder: its `model.yml` is there. */
const holdsModel = (dir: DiskDir): boolean =>
  someInTree(dir, (file) => file.name === 'model.yml')

/** The folder at `id` (`/`-separated) under `root`. */
export function findDir(root: DiskDir | null, id: string): DiskDir | null {
  let dir = root
  for (const segment of id.split('/').filter(Boolean)) {
    dir = dir?.dirs.find((child) => child.name === segment) ?? null
    if (!dir) return null
  }
  return dir === root ? null : dir
}

/**
 * The downloads under `root` that left partial files behind, one per folder.
 *
 * A model's folder is created by its download and its `model.yml` is written
 * last, so a folder with partials and no `model.yml` anywhere in it holds
 * nothing but that unfinished download: all of it goes. Where a model is
 * installed (a re-download, a projector or draft fetched later), only the
 * partial files go and the model stays — also in a subfolder of an installed
 * model (an MLX repo's `assets/`), which is part of that model.
 */
export function findPartialDownloads(
  tree: DiskDir | null,
  root: DownloadRoot
): PartialDownload[] {
  const found: PartialDownload[] = []
  const visit = (dir: DiskDir, id: string, insideModel: boolean) => {
    const partials = dir.files.filter((file) => isPartialFile(file.name))
    if (id && partials.length > 0) {
      if (!insideModel && !dir.truncated && !holdsModel(dir)) {
        found.push({ root, id, paths: [dir.path], bytes: treeBytes(dir) })
        return
      }
      found.push({
        root,
        id,
        paths: partials.map((file) => file.path),
        bytes: partials.reduce((sum, file) => sum + file.bytes, 0),
      })
    }
    const childrenInsideModel =
      insideModel || dir.files.some((file) => file.name === 'model.yml')
    for (const child of dir.dirs) {
      visit(child, id ? `${id}/${child.name}` : child.name, childrenInsideModel)
    }
  }
  if (tree) visit(tree, '', false)
  return found
}

/** What the MLX extension accepts as a draft folder (`resolveLocalDraftDir`). */
const isUsableDraft = (dir: DiskDir): boolean =>
  dir.files.some((file) => file.name === 'config.json') &&
  dir.files.some((file) => file.name.endsWith('.safetensors'))

/**
 * The drafter families the MLX extension downloads: DFlash (`z-lab/*-DFlash`),
 * MTP (`*-assistant-*`, `*-MTP-*`) and EAGLE-3 (`*speculator.eagle3`).
 */
const DRAFT_REPO_NAME = /dflash|assistant|-mtp|eagle3|speculator/i

/**
 * Complete MLX drafts on disk: every repo cached under `mlx/draft-models/<org>/<repo>`,
 * and a draft repo imported into `mlx/models/<org>_<repo>` (no `model.yml`, so no
 * model list names it). A draft still downloading is a partial download instead.
 */
export function findMlxDrafts(
  models: DiskDir | null,
  drafts: DiskDir | null
): MlxDraft[] {
  const found: MlxDraft[] = []
  const complete = (dir: DiskDir) =>
    isUsableDraft(dir) &&
    !dir.truncated &&
    !someInTree(dir, (file) => isPartialFile(file.name))
  for (const org of drafts?.dirs ?? []) {
    for (const repo of org.dirs) {
      if (!complete(repo)) continue
      found.push({
        id: `${org.name}/${repo.name}`,
        path: repo.path,
        bytes: treeBytes(repo),
      })
    }
  }
  for (const dir of models?.dirs ?? []) {
    if (!DRAFT_REPO_NAME.test(dir.name) || holdsModel(dir) || !complete(dir))
      continue
    found.push({ id: dir.name, path: dir.path, bytes: treeBytes(dir) })
  }
  return found
}

/**
 * Bytes of an MLX model's folder, the partial files of a download into it aside;
 * `null` when the folder holds no weights — an import whose files stay where
 * they were, which removing the model does not free.
 */
export function mlxModelFolderBytes(
  models: DiskDir | null,
  modelId: string
): number | null {
  const dir = findDir(models, modelId)
  if (!dir || dir.truncated) return null
  if (!someInTree(dir, (file) => isWeightsFile(file.name))) return null
  const bytes = treeBytes(dir, true)
  return bytes > 0 ? bytes : null
}

/** `file://` paths are resolved by the data folder's file commands against the data folder. */
const dataPath = (relative: string): string => `file://${relative}`

/**
 * Read the download roots and pick out what the page lists from them. `mlxModelIds`
 * are the MLX models whose recorded size is missing.
 */
export async function scanDownloadsDisk(
  mlxModelIds: readonly string[]
): Promise<DownloadsDiskScan> {
  const [llamacpp, mlxModels, mlxDrafts] = await Promise.all([
    readDiskTree(dataPath(LLAMACPP_MODELS_ROOT)),
    readDiskTree(dataPath(MLX_MODELS_ROOT)),
    readDiskTree(dataPath(MLX_DRAFTS_ROOT)),
  ])
  const mlxModelBytes: Record<string, number> = {}
  for (const id of mlxModelIds) {
    const bytes = mlxModelFolderBytes(mlxModels, id)
    if (bytes !== null) mlxModelBytes[id] = bytes
  }
  return {
    mlxModelBytes,
    partials: [
      ...findPartialDownloads(llamacpp, LLAMACPP_MODELS_ROOT),
      ...findPartialDownloads(mlxModels, MLX_MODELS_ROOT),
      ...findPartialDownloads(mlxDrafts, MLX_DRAFTS_ROOT),
    ],
    drafts: findMlxDrafts(mlxModels, mlxDrafts),
  }
}

/** Delete what a scan named; a path already gone is skipped, not an error. */
export async function removeDiskPaths(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if (await fs.existsSync(path)) await fs.rm(path)
  }
}
