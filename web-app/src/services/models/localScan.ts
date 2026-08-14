/**
 * Local model scanner: detects models already downloaded by other apps
 * (LM Studio / Hugging Face cache / Unsloth / Ollama) so the user can run them
 * in Atomic Chat WITHOUT re-downloading. The engine `import()` already accepts
 * an absolute path and skips the download (it writes a `model.yml` pointing at
 * the existing file); this module only finds the candidates.
 *
 * Scope: LM Studio, HF cache, Unsloth (exports/ runnable + outputs/ marked),
 * and Ollama (manifest → blob, exposed as a `.gguf` symlink without copying).
 * Only text-generation models are returned — embedding/reranker weights live in
 * the same caches but crash `llama-server` when loaded as a chat model.
 *
 * All filesystem access goes through the existing unscoped Tauri commands
 * (`readdir_sync` / `read_file_sync` / `exists_sync` / `file_stat`) which accept
 * absolute paths, plus the `get_os_home_dir` command for the real OS home.
 * Everything is best-effort and defensive: a missing/unreadable directory just
 * yields no candidates rather than throwing.
 */
import { getServiceHub } from '@/hooks/useServiceHub'

export type LocalScanFormat = 'gguf' | 'mlx' | 'adapter'

export type LocalModelSource = NonNullable<Model['source']>

export interface LocalModelCandidate {
  /** Sanitized id used as the import id (and provider model id). */
  id: string
  /** Human-readable label for the onboarding row. */
  displayName: string
  /** Absolute path: a `.gguf` file (gguf) or a model folder (mlx/adapter). */
  path: string
  format: LocalScanFormat
  source: LocalModelSource
  /** Companion multimodal projector (`mmproj`) for GGUF vision models. */
  mmprojPath?: string
  sizeBytes?: number
  /**
   * Whether this candidate can be imported & run as-is. LoRA adapters from
   * Unsloth `outputs/` need a base model first, so they're listed but disabled.
   */
  runnable: boolean
  /** Short reason shown when `runnable` is false (e.g. "requires base model"). */
  note?: string
}

const MAX_WALK_DEPTH = 6

function core() {
  return getServiceHub().core()
}

async function osHomeDir(): Promise<string | null> {
  try {
    const home = await core().invoke<string>('get_os_home_dir')
    return home && home.length > 0 ? home : null
  } catch {
    return null
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return await core().invoke<boolean>('exists_sync', { args: [path] })
  } catch {
    return false
  }
}

/** Absolute child paths of a directory (empty on any error / missing dir). */
async function listDir(path: string): Promise<string[]> {
  try {
    return (await core().invoke<string[]>('readdir_sync', { args: [path] })) ?? []
  } catch {
    return []
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await core().invoke<string>('read_file_sync', { args: [path] })
  } catch {
    return null
  }
}

async function statOf(
  path: string
): Promise<{ isDirectory: boolean; size: number } | null> {
  try {
    // The Rust FileStat serializes camelCase (`isDirectory`), matching the
    // core fs wrapper used by extensions.
    const s = await core().invoke<{ isDirectory?: boolean; size?: number }>(
      'file_stat',
      { args: path }
    )
    return { isDirectory: !!s?.isDirectory, size: s?.size ?? 0 }
  } catch {
    return null
  }
}

/**
 * Link `target` (an existing file) to `link` without copying. Returns true on
 * success (symlink, or hardlink fallback). Used for Ollama blobs → `.gguf`.
 */
async function createSymlink(target: string, link: string): Promise<boolean> {
  try {
    await core().invoke<string>('create_symlink', { target, link })
    return true
  } catch {
    return false
  }
}

const SEP = IS_WINDOWS ? '\\' : '/'

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join(SEP)
    .replace(/[\\/]+/g, SEP)
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** GGUF import ids: `^[a-zA-Z0-9/_\-\.]+$` (see llamacpp-extension import()). */
function sanitizeGgufId(raw: string): string {
  return (
    raw
      .replace(/\.gguf$/i, '')
      .replace(/[^a-zA-Z0-9/_\-.]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-/.]+|[-/.]+$/g, '') || 'model'
  )
}

/** MLX ids mirror getMlxModelId in SetupScreen (spaces→`-`, strip the rest). */
function sanitizeMlxId(raw: string): string {
  return (
    raw
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9\-_./]/g, '')
      .replace(/^[-/.]+|[-/.]+$/g, '') || 'model'
  )
}

function looksLikeMmproj(fileName: string): boolean {
  const f = fileName.toLowerCase()
  return f.includes('mmproj') || f.includes('mproj')
}

/**
 * Recursively collect `.gguf` files under a directory (bounded depth). Splits
 * results into the main weight files and the mmproj projector files.
 */
async function collectGgufFiles(
  root: string,
  depth = 0
): Promise<{ models: string[]; mmprojs: string[] }> {
  const models: string[] = []
  const mmprojs: string[] = []
  if (depth > MAX_WALK_DEPTH) return { models, mmprojs }

  for (const child of await listDir(root)) {
    const name = basename(child)
    if (name.startsWith('.')) continue
    const st = await statOf(child)
    if (!st) continue
    if (st.isDirectory) {
      const nested = await collectGgufFiles(child, depth + 1)
      models.push(...nested.models)
      mmprojs.push(...nested.mmprojs)
    } else if (name.toLowerCase().endsWith('.gguf')) {
      if (looksLikeMmproj(name)) mmprojs.push(child)
      else models.push(child)
    }
  }
  return { models, mmprojs }
}

/** A directory is an MLX/safetensors model when it has config.json + weights. */
async function isSafetensorsModelDir(dir: string): Promise<boolean> {
  let hasConfig = false
  let hasWeights = false
  for (const child of await listDir(dir)) {
    const name = basename(child).toLowerCase()
    if (name === 'config.json') hasConfig = true
    if (name.endsWith('.safetensors')) hasWeights = true
    if (hasConfig && hasWeights) return true
  }
  return false
}

/** Unsloth LoRA adapter dir: adapter_config.json + adapter weights. */
async function isAdapterDir(dir: string): Promise<boolean> {
  for (const child of await listDir(dir)) {
    if (basename(child).toLowerCase() === 'adapter_config.json') return true
  }
  return false
}

function ggufCandidate(
  file: string,
  source: LocalModelSource,
  mmprojPath: string | undefined,
  sizeBytes: number | undefined
): LocalModelCandidate {
  const name = basename(file)
  return {
    id: sanitizeGgufId(name),
    displayName: name.replace(/\.gguf$/i, ''),
    path: file,
    format: 'gguf',
    source,
    mmprojPath,
    sizeBytes,
    runnable: true,
  }
}

function mlxCandidate(
  dir: string,
  source: LocalModelSource,
  sizeBytes: number | undefined
): LocalModelCandidate {
  const name = basename(dir)
  return {
    id: sanitizeMlxId(name),
    displayName: name,
    path: dir,
    format: 'mlx',
    source,
    sizeBytes,
    runnable: true,
  }
}

/**
 * Walk a root that holds GGUF and/or safetensors model dirs and turn them into
 * candidates. `allowMlx` lets callers suppress MLX on non-Apple-Silicon.
 */
async function scanGenericRoot(
  root: string,
  source: LocalModelSource,
  allowMlx: boolean
): Promise<LocalModelCandidate[]> {
  if (!(await pathExists(root))) return []
  const out: LocalModelCandidate[] = []

  // GGUF files (any depth) — runnable by llama.cpp.
  const { models, mmprojs } = await collectGgufFiles(root)
  const mmprojByDir = new Map<string, string>()
  for (const m of mmprojs) mmprojByDir.set(dirOf(m), m)
  for (const file of models) {
    const st = await statOf(file)
    out.push(
      ggufCandidate(file, source, mmprojByDir.get(dirOf(file)), st?.size)
    )
  }

  // MLX / safetensors model folders (one level of publisher/model nesting).
  if (allowMlx) {
    for (const lvl1 of await listDir(root)) {
      const st1 = await statOf(lvl1)
      if (!st1?.isDirectory) continue
      if (await isSafetensorsModelDir(lvl1)) {
        out.push(mlxCandidate(lvl1, source, st1.size))
        continue
      }
      for (const lvl2 of await listDir(lvl1)) {
        const st2 = await statOf(lvl2)
        if (!st2?.isDirectory) continue
        if (await isSafetensorsModelDir(lvl2)) {
          out.push(mlxCandidate(lvl2, source, st2.size))
        }
      }
    }
  }

  return out
}

function dirOf(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join(SEP)
}

// --- LM Studio ------------------------------------------------------------

async function lmStudioRoots(home: string): Promise<string[]> {
  const roots = new Set<string>()
  // Honor an explicit downloadsFolder from ~/.lmstudio/settings.json (guard
  // existence first so a missing file doesn't log a scary invoke error).
  const settingsPath = joinPath(home, '.lmstudio', 'settings.json')
  if (await pathExists(settingsPath)) {
    const settings = await readText(settingsPath)
    if (settings) {
      try {
        const parsed = JSON.parse(settings) as { downloadsFolder?: string }
        if (parsed.downloadsFolder) roots.add(parsed.downloadsFolder)
      } catch {
        // ignore malformed settings
      }
    }
  }
  roots.add(joinPath(home, '.lmstudio', 'models'))
  roots.add(joinPath(home, '.cache', 'lm-studio', 'models'))
  return [...roots]
}

async function scanLmStudio(home: string): Promise<LocalModelCandidate[]> {
  const out: LocalModelCandidate[] = []
  for (const root of await lmStudioRoots(home)) {
    out.push(...(await scanGenericRoot(root, 'lmstudio', IS_MACOS)))
  }
  return out
}

// --- Hugging Face cache ---------------------------------------------------

/** Resolve the snapshot dir HF currently points `main` at (else first one). */
async function resolveHfSnapshot(repoDir: string): Promise<string | null> {
  const snapshotsDir = joinPath(repoDir, 'snapshots')
  const snapshots = await listDir(snapshotsDir)
  if (snapshots.length === 0) return null
  const ref = await readText(joinPath(repoDir, 'refs', 'main'))
  if (ref) {
    const hash = ref.trim()
    const match = snapshots.find((s) => basename(s) === hash)
    if (match) return match
  }
  return snapshots[0]
}

async function scanHfCacheRoot(
  hubDir: string,
  source: LocalModelSource
): Promise<LocalModelCandidate[]> {
  if (!(await pathExists(hubDir))) return []
  const out: LocalModelCandidate[] = []
  for (const entry of await listDir(hubDir)) {
    const name = basename(entry)
    if (!name.startsWith('models--')) continue
    const st = await statOf(entry)
    if (!st?.isDirectory) continue
    const snapshot = await resolveHfSnapshot(entry)
    if (!snapshot) continue
    // repo id e.g. "models--mlx-community--Qwen3" -> "mlx-community/Qwen3"
    const repoId = name.replace(/^models--/, '').replace(/--/g, '/')
    const isMlxRepo = /(^|\/)mlx-community\//i.test(`/${repoId}`) ||
      /mlx/i.test(repoId)

    const { models, mmprojs } = await collectGgufFiles(snapshot)
    const mmprojByDir = new Map<string, string>()
    for (const m of mmprojs) mmprojByDir.set(dirOf(m), m)
    for (const file of models) {
      const fst = await statOf(file)
      const cand = ggufCandidate(
        file,
        source,
        mmprojByDir.get(dirOf(file)),
        fst?.size
      )
      cand.id = sanitizeGgufId(`${repoId}/${basename(file)}`)
      out.push(cand)
    }

    // MLX-format repos are only runnable on Apple Silicon.
    if (IS_MACOS && isMlxRepo && (await isSafetensorsModelDir(snapshot))) {
      const cand = mlxCandidate(snapshot, source, st.size)
      cand.id = sanitizeMlxId(repoId)
      cand.displayName = repoId
      out.push(cand)
    }
  }
  return out
}

async function scanHfCache(home: string): Promise<LocalModelCandidate[]> {
  return scanHfCacheRoot(
    joinPath(home, '.cache', 'huggingface', 'hub'),
    'huggingface-cache'
  )
}

// --- Unsloth --------------------------------------------------------------

function unslothRoot(home: string): string {
  // Env override (UNSLOTH_STUDIO_HOME / STUDIO_HOME) is a phase-2 nicety; the
  // renderer can't read arbitrary env, so MVP uses the default location.
  return joinPath(home, '.unsloth', 'studio')
}

async function scanUnsloth(home: string): Promise<LocalModelCandidate[]> {
  const root = unslothRoot(home)
  if (!(await pathExists(root))) return []
  const out: LocalModelCandidate[] = []

  // exports/ — exported GGUF / merged checkpoints: directly runnable.
  out.push(
    ...(await scanGenericRoot(joinPath(root, 'exports'), 'unsloth', IS_MACOS))
  )

  // cache/huggingface/hub — Unsloth's own HF-layout cache (chat models).
  out.push(
    ...(await scanHfCacheRoot(
      joinPath(root, 'cache', 'huggingface', 'hub'),
      'unsloth'
    ))
  )

  // outputs/ — training results. Merged checkpoints (GGUF) are runnable; LoRA
  // adapters need a base model, so we list them disabled (phase 2).
  const outputsDir = joinPath(root, 'outputs')
  if (await pathExists(outputsDir)) {
    out.push(...(await scanGenericRoot(outputsDir, 'unsloth', IS_MACOS)))
    for (const run of await listDir(outputsDir)) {
      const st = await statOf(run)
      if (!st?.isDirectory) continue
      if (await isAdapterDir(run)) {
        out.push({
          id: sanitizeMlxId(basename(run)),
          displayName: basename(run),
          path: run,
          format: 'adapter',
          source: 'unsloth',
          runnable: false,
          note: 'requires base model',
        })
      }
    }
  }

  return out
}

// --- Ollama ---------------------------------------------------------------

interface OllamaLayer {
  mediaType?: string
  digest?: string
  size?: number
}

/** Recursively collect FILES (not dirs) under a directory, bounded depth. */
async function collectFilesRecursive(
  root: string,
  depth = 0
): Promise<string[]> {
  const files: string[] = []
  if (depth > MAX_WALK_DEPTH) return files
  for (const child of await listDir(root)) {
    if (basename(child).startsWith('.')) continue
    const st = await statOf(child)
    if (!st) continue
    if (st.isDirectory) files.push(...(await collectFilesRecursive(child, depth + 1)))
    else files.push(child)
  }
  return files
}

/** `sha256:<hex>` → `<blobsDir>/sha256-<hex>`. */
function digestToBlobPath(blobsDir: string, digest: string): string {
  return joinPath(blobsDir, digest.replace(':', '-'))
}

/**
 * Detect Ollama models. Ollama stores weights as content-addressed blobs with
 * no extension, described by OCI-style manifests. We parse each manifest, map
 * the `image.model` layer (and `image.projector` for vision) to its blob, and
 * expose it as a runnable `*.gguf` via a symlink in `<ollama>/.studio_links/`
 * (never copying the blob). Models whose link can't be created are skipped.
 */
async function scanOllama(home: string): Promise<LocalModelCandidate[]> {
  // Default store; OLLAMA_MODELS env override is phase 2 (no renderer env).
  const root = joinPath(home, '.ollama', 'models')
  const manifestsDir = joinPath(root, 'manifests')
  const blobsDir = joinPath(root, 'blobs')
  const linksDir = joinPath(root, '.studio_links')
  if (!(await pathExists(manifestsDir))) return []

  const out: LocalModelCandidate[] = []
  for (const manifestFile of await collectFilesRecursive(manifestsDir)) {
    const raw = await readText(manifestFile)
    if (!raw) continue
    let layers: OllamaLayer[]
    try {
      const parsed = JSON.parse(raw) as { layers?: OllamaLayer[] }
      if (!Array.isArray(parsed.layers)) continue
      layers = parsed.layers
    } catch {
      continue
    }

    const modelLayer = layers.find((l) =>
      l.mediaType?.endsWith('image.model')
    )
    if (!modelLayer?.digest) continue
    const blobPath = digestToBlobPath(blobsDir, modelLayer.digest)
    if (!(await pathExists(blobPath))) continue

    // Derive a readable name from the manifest path: <host>/<ns>/<model>/<tag>.
    const rel = manifestFile.slice(manifestsDir.length + 1)
    const parts = rel.split(/[\\/]/).filter(Boolean)
    const tag = parts[parts.length - 1] ?? 'latest'
    const model = parts[parts.length - 2] ?? 'model'
    const base = sanitizeGgufId(`${model}-${tag}`)

    const linkPath = joinPath(linksDir, `${base}.gguf`)
    if (!(await createSymlink(blobPath, linkPath))) continue

    // Vision projector → mmproj (best-effort; skip link on failure).
    let mmprojPath: string | undefined
    const projLayer = layers.find((l) =>
      l.mediaType?.endsWith('image.projector')
    )
    if (projLayer?.digest) {
      const projBlob = digestToBlobPath(blobsDir, projLayer.digest)
      const projLink = joinPath(linksDir, `${base}.mmproj.gguf`)
      if (
        (await pathExists(projBlob)) &&
        (await createSymlink(projBlob, projLink))
      ) {
        mmprojPath = projLink
      }
    }

    out.push({
      id: sanitizeGgufId(`ollama/${model}-${tag}`),
      displayName: `${model}:${tag}`,
      path: linkPath,
      format: 'gguf',
      source: 'ollama',
      mmprojPath,
      sizeBytes: modelLayer.size,
      runnable: true,
    })
  }
  return out
}

// --- Model kind -----------------------------------------------------------

/**
 * llama.cpp architectures that cannot generate text: encoder-only embedding
 * backbones and the projector/audio side-models. Loading one as a chat model
 * trips a GGML assert and kills the server process, so they must never reach
 * onboarding.
 */
const NON_TEXT_GGUF_ARCHITECTURES = new Set([
  'bert',
  'modern-bert',
  'nomic-bert',
  'nomic-bert-moe',
  'neo-bert',
  'jina-bert-v2',
  'jina-bert-v3',
  'eurobert',
  'gemma-embedding',
  'llama-embed',
  't5encoder',
  'clip',
  'wavtokenizer-dec',
])

/** Transformers heads that are classifiers, not decoders. */
const NON_TEXT_HF_ARCHITECTURE_SUFFIXES = [
  'formaskedlm',
  'forsequenceclassification',
  'fortokenclassification',
]

/** `config.json` `model_type` values of encoder-only / non-LLM families. */
const NON_TEXT_HF_MODEL_TYPES = new Set([
  'bert',
  'roberta',
  'xlm-roberta',
  'xlm_roberta',
  'distilbert',
  'albert',
  'electra',
  'camembert',
  'deberta',
  'deberta-v2',
  'mpnet',
  'modernbert',
  'nomic_bert',
  'jina_bert',
  'clip',
  'siglip',
  'whisper',
])

/**
 * Decide from GGUF metadata whether a file is a text generator. Unknown
 * architectures pass: hiding a usable model is worse than listing an exotic one.
 */
export function isTextGenerationGguf(
  metadata: Record<string, string>
): boolean {
  const arch = metadata['general.architecture']?.trim().toLowerCase()
  if (!arch) return true
  if (NON_TEXT_GGUF_ARCHITECTURES.has(arch)) return false

  // Embedding/reranker conversions of a generative architecture (Qwen3-Embedding
  // and friends) keep the arch name but carry a pooling type or a classifier
  // head. Pooling type 0 is NONE, i.e. a plain decoder.
  const pooling = metadata[`${arch}.pooling_type`]?.trim()
  if (pooling !== undefined && pooling !== '' && pooling !== '0') return false
  return metadata[`${arch}.classifier.output_labels`] === undefined
}

/** Same decision for a safetensors/MLX folder, from its `config.json`. */
export function isTextGenerationHfConfig(rawConfig: string | null): boolean {
  if (!rawConfig) return true
  let parsed: { architectures?: unknown; model_type?: unknown }
  try {
    parsed = JSON.parse(rawConfig)
  } catch {
    return true
  }

  const architectures = (
    Array.isArray(parsed.architectures) ? parsed.architectures : []
  )
    .filter((a): a is string => typeof a === 'string')
    .map((a) => a.toLowerCase())
  if (
    architectures.some((a) =>
      NON_TEXT_HF_ARCHITECTURE_SUFFIXES.some((suffix) => a.endsWith(suffix))
    )
  ) {
    return false
  }

  const modelType =
    typeof parsed.model_type === 'string'
      ? parsed.model_type.trim().toLowerCase()
      : ''
  return !(modelType && NON_TEXT_HF_MODEL_TYPES.has(modelType))
}

/** GGUF key/value header of a local file (null when it can't be parsed). */
async function readGgufMetadata(
  path: string
): Promise<Record<string, string> | null> {
  try {
    const result = await core().invoke<{ metadata?: Record<string, string> }>(
      'plugin:llamacpp|read_gguf_metadata',
      { path }
    )
    return result?.metadata ?? null
  } catch {
    return null
  }
}

async function isTextGenerationCandidate(
  cand: LocalModelCandidate
): Promise<boolean> {
  if (cand.format === 'gguf') {
    const metadata = await readGgufMetadata(cand.path)
    return metadata ? isTextGenerationGguf(metadata) : true
  }
  if (cand.format === 'mlx') {
    return isTextGenerationHfConfig(
      await readText(joinPath(cand.path, 'config.json'))
    )
  }
  return true
}

// Each probe reads a file header; a handful in flight keeps the scan snappy on
// a cache with dozens of models without hammering a spinning disk.
const KIND_PROBE_CONCURRENCY = 4

async function keepTextGenerationOnly(
  cands: LocalModelCandidate[]
): Promise<LocalModelCandidate[]> {
  const keep = new Array<boolean>(cands.length).fill(true)
  let next = 0

  const worker = async () => {
    while (next < cands.length) {
      const index = next++
      keep[index] = await isTextGenerationCandidate(cands[index])
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(KIND_PROBE_CONCURRENCY, cands.length) }, () =>
      worker()
    )
  )

  return cands.filter((_, index) => keep[index])
}

export interface ScanLocalModelsOptions {
  // When false, scanning is disabled and an empty list is returned.
  enabled?: boolean
  // Extra user-configured folders to scan (Settings → scan folders).
  extraRoots?: string[]
  // Absolute paths of already-imported models, dropped from the results.
  importedPaths?: Iterable<string>
}

// Normalize a path for comparison: trim trailing separators, unify slashes.
function normalizePathKey(path: string): string {
  return path.replace(/[\\/]+$/g, '').replace(/[\\/]+/g, SEP)
}

// Scan every source and return de-duplicated text-generation candidates, minus
// already-imported ones.
export async function scanLocalModels(
  options: ScanLocalModelsOptions = {}
): Promise<LocalModelCandidate[]> {
  const { enabled = true, extraRoots = [], importedPaths } = options
  if (!enabled) return []

  const home = await osHomeDir()
  if (!home) return []

  // Custom folders are scanned as generic roots (GGUF + MLX), labeled 'local'.
  const customGroups = await Promise.all(
    extraRoots.map((root) =>
      scanGenericRoot(root, 'local', IS_MACOS).catch(() => [])
    )
  )

  const groups = await Promise.all([
    scanLmStudio(home).catch(() => []),
    scanHfCache(home).catch(() => []),
    scanUnsloth(home).catch(() => []),
    scanOllama(home).catch(() => []),
  ])

  const importedKeys = new Set<string>()
  if (importedPaths) {
    for (const p of importedPaths) {
      if (p) importedKeys.add(normalizePathKey(p))
    }
  }

  const seenPaths = new Set<string>()
  const seenIds = new Set<string>()
  const result: LocalModelCandidate[] = []

  for (const cand of [...customGroups.flat(), ...groups.flat()]) {
    const key = normalizePathKey(cand.path)
    if (seenPaths.has(key)) continue
    seenPaths.add(key)
    if (importedKeys.has(key)) continue

    // Keep ids unique so two files don't collide on import.
    let id = cand.id
    let n = 2
    while (seenIds.has(id)) {
      id = `${cand.id}-${n++}`
    }
    seenIds.add(id)

    result.push({ ...cand, id })
  }

  return keepTextGenerationOnly(result)
}

// Absolute weights paths of locally-imported models, for deduping scan candidates.
export function collectImportedModelPaths(
  providers: Array<{ provider: string; models: Array<{ path?: string }> }>
): string[] {
  const localProviders = new Set(['llamacpp', 'llamacpp-upstream', 'mlx'])
  const paths: string[] = []

  for (const p of providers) {
    if (!localProviders.has(p.provider)) continue
    for (const m of p.models) {
      if (m.path) paths.push(m.path)
    }
  }

  return paths
}
