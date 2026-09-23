/**
 * Image generation without gigabytes: the core's scripted `sd-server` installed
 * as this profile's image engine, catalog "models" whose files are a few bytes
 * of exactly the size the catalog says, and the caches the webview would have
 * fetched from GitHub, seeded so the page opens offline with a model to run.
 *
 * The UI decides "installed" from the core's install record and "downloaded"
 * from byte sizes (`lib/diffusion/models.ts`), never from a checksum, which is
 * what makes tiny stand-ins work. The fake engine and its installer come from
 * the sibling `atomic-chat-core` checkout, like the fake llama.cpp backend.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser } from 'webdriverio'
import { coreRequest } from './core.js'
import { CORE_REPO } from './fixtures.js'
import { listProcesses } from './platform.js'
import type { Profile } from './profile.js'
import type { Session } from './session.js'

/** A build newer than any the app ships, so the seeded manifest never offers an update. */
export const IMAGE_ENGINE_TAG = 'master-900-e2e0001'
/** The build app v2.0.40 shipped: too old for Qwen Image 2.1, which needs 883. */
export const OLD_IMAGE_ENGINE_TAG = 'master-849-d04e895'
/** The backend the sd.cpp matrix picks on an Apple Silicon Mac. */
export const IMAGE_BACKEND_ID = 'macos-arm64'
export const IMAGE_ENGINE_ASSET = 'sd-master-e2e0001-bin-Darwin-macOS-arm64.zip'

export const IMAGE_FAMILY = 'z-image'
export const IMAGE_QUANT = 'q4_k'
export const IMAGE_ARTIFACT = `${IMAGE_FAMILY}:${IMAGE_QUANT}`
export const GATED_FAMILY = 'qwen-image-2.1'
export const GATED_ARTIFACT = `${GATED_FAMILY}:${IMAGE_QUANT}`

type CatalogFile = { repo: string; filename: string; bytes: number; field?: string }
type CatalogFamily = {
  id: string
  name: string
  modality: 'image'
  engines: string[]
  transformer: { repo: string; quants: Array<{ id: string; label: string; filename: string; bytes: number; recommended?: boolean }> }
  vae?: CatalogFile
  text_encoders: CatalogFile[]
  defaults: { steps: number; cfg_scale: number; width: number; height: number }
  ranges: { steps: [number, number]; dims: [number, number]; dim_multiple: number }
  capabilities: { negative_prompt: boolean; guidance: boolean; workflows: string[] }
}

const SHARED_REPO = 'e2e/shared'

/**
 * Two families, as `atomic-chat-conf/models/diffusion.json` would list them,
 * with byte counts a test can write out. Z-Image has the img2img workflows and
 * runs on any engine; Qwen Image 2.1 needs engine build 883 or newer.
 */
export function imageCatalogFixture(): { schema_version: number; updated_at: string; families: CatalogFamily[] } {
  const common = {
    modality: 'image' as const,
    engines: ['sdcpp'],
    defaults: { steps: 4, cfg_scale: 1, width: 256, height: 256 },
    ranges: { steps: [1, 50] as [number, number], dims: [256, 2048] as [number, number], dim_multiple: 16 },
  }
  return {
    schema_version: 1,
    updated_at: '2026-09-22T00:00:00Z',
    families: [
      {
        ...common,
        id: IMAGE_FAMILY,
        name: 'Z-Image Turbo',
        transformer: {
          repo: 'e2e/Z-Image-Turbo',
          quants: [{ id: IMAGE_QUANT, label: 'Q4_K', filename: 'z-image-turbo-q4_k.gguf', bytes: 64, recommended: true }],
        },
        vae: { repo: SHARED_REPO, filename: 'ae.safetensors', bytes: 32 },
        text_encoders: [{ repo: SHARED_REPO, filename: 'qwen3-4b.gguf', bytes: 48, field: 'llm' }],
        capabilities: { negative_prompt: false, guidance: false, workflows: ['create', 'transform', 'inpaint', 'extend', 'upscale'] },
      },
      {
        ...common,
        id: GATED_FAMILY,
        name: 'Qwen Image 2.1',
        transformer: {
          repo: 'e2e/Qwen-Image-2.1',
          quants: [{ id: IMAGE_QUANT, label: 'Q4_K', filename: 'qwen-image-2.1-q4_k.gguf', bytes: 80, recommended: true }],
        },
        vae: { repo: SHARED_REPO, filename: 'qwen-vae.safetensors', bytes: 40 },
        text_encoders: [{ repo: SHARED_REPO, filename: 'qwen3-vl.gguf', bytes: 56, field: 'llm' }],
        capabilities: { negative_prompt: false, guidance: false, workflows: ['create', 'reference', 'edit'] },
      },
    ],
  }
}

/** The sd.cpp release manifest the app would have fetched, naming one macOS build. */
export function imageManifestFixture(options: { tag?: string; asset?: { name: string; sha256: string; size: number } } = {}) {
  return {
    tag_name: options.tag ?? IMAGE_ENGINE_TAG,
    upstream_repo: 'leejet/stable-diffusion.cpp',
    assets: [
      options.asset
        ? { backend: IMAGE_BACKEND_ID, ...options.asset }
        : { backend: IMAGE_BACKEND_ID, name: IMAGE_ENGINE_ASSET, size: 1024 },
    ],
  }
}

export interface ImageSeedOptions {
  /** The checkpoint the Images page shows as selected; `null` for none. */
  selected?: string | null
  manifestTag?: string
  manifestAsset?: { name: string; sha256: string; size: number }
  /** Overrides on the persisted image settings (`useImageSetting`). */
  setting?: Record<string, unknown>
  /** Overrides on the persisted form draft (`useImageForm`): `steps`, `width`, `height`, … */
  form?: Record<string, unknown>
}

/**
 * What to put in the webview's localStorage before the first page script: the
 * catalog and manifest caches (fresh, so nothing is fetched) and the image
 * settings with the tour already done.
 */
export function imageSeed(options: ImageSeedOptions = {}): Record<string, string> {
  const now = String(Date.now())
  const seed: Record<string, string> = {
    atomic_diffusion_catalog_cache_v1: JSON.stringify(imageCatalogFixture()),
    atomic_diffusion_catalog_cache_ts_v1: now,
    atomic_sdcpp_manifest_cache_v1: JSON.stringify(
      imageManifestFixture({ tag: options.manifestTag, asset: options.manifestAsset })
    ),
    atomic_sdcpp_manifest_cache_ts_v1: now,
    'setting-images': JSON.stringify({
      state: {
        setupCompleted: true,
        selectedArtifactId: options.selected === undefined ? IMAGE_ARTIFACT : options.selected,
        evictChatModel: 'whenNeeded',
        idleUnloadMinutes: 0,
        outputDir: null,
        ...options.setting,
      },
      version: 1,
    }),
  }
  if (options.form) {
    seed['image-form'] = JSON.stringify({
      state: { width: 256, height: 256, steps: 4, cfgScale: 1, batchSize: 1, runs: 1, ...options.form },
      version: 2,
    })
  }
  return seed
}

export interface FakeSdOptions {
  mode?: 'ready' | 'hang' | 'exit-early' | 'foreign' | 'queue-full' | 'fail-job' | 'die-mid-job' | 'ggml-abort' | 'gpu-fault'
  loadMs?: number
  stepMs?: number
  cancel?: boolean
  tiles?: number
  stderr?: string
  ignoreSigterm?: boolean
  blankSeed?: number
  onceMarker?: string
  /** `supported_modes` the fake advertises; `img_gen` by default, `vid_gen` for a video engine. */
  modes?: Array<'img_gen' | 'vid_gen'>
  /** What `output_formats_by_mode.vid_gen` says: every format, none with WebM, or nothing at all. */
  vidFormats?: 'all' | 'no-webm' | 'unreported'
  /** Where the fake appends its pid on every start. */
  pidFile?: string
  /** Where the fake writes the argv of its last start. */
  argvFile?: string
}

export interface FakeImageEngine {
  dir: string
  tag: string
  /** Every pid the fake appended, one per start. */
  pidFile: string
  /** The argv of the last start, as JSON. */
  argvFile: string
}

async function coreHelper<T>(file: string): Promise<T> {
  const { pathToFileURL } = await import('node:url')
  return (await import(/* @vite-ignore */ pathToFileURL(join(CORE_REPO, file)).href)) as T
}

/**
 * The scripted `sd-server` installed as an owned engine tree under the data
 * folder, at a tag and backend id the seeded manifest agrees with, so the
 * page sees an engine and no update. Call it from `prepare`.
 */
export async function installFakeImageEngine(
  profile: Profile,
  options: FakeSdOptions & { tag?: string } = {}
): Promise<FakeImageEngine> {
  const config = await coreHelper<{ dataLayout: (root: string) => unknown }>('src/config/index.ts')
  const fake = await coreHelper<{
    installFakeSdEngine: (layout: unknown, options: Record<string, unknown>) => Promise<{ dir: string; tag: string }>
  }>('test/helpers/fake-sd-server.ts')
  const tag = options.tag ?? IMAGE_ENGINE_TAG
  const pidFile = options.pidFile ?? join(profile.root, `sd-pids-${tag}`)
  const argvFile = options.argvFile ?? join(profile.root, `sd-argv-${tag}.json`)
  const { tag: _tag, ...fakeOptions } = options
  const record = await fake.installFakeSdEngine(config.dataLayout(profile.dataFolder), {
    tag,
    backendId: IMAGE_BACKEND_ID,
    backend: 'metal',
    // Slow enough that the page shows progress, fast enough for a test.
    stepMs: 150,
    ...fakeOptions,
    pidFile,
    argvFile,
  })
  return { dir: record.dir, tag: record.tag, pidFile, argvFile }
}

/** `provider/name` → `provider--name`, the way the app lays shared files out. */
const sharedDir = (repo: string) => repo.replace(/\//g, '--')
const basename = (filename: string) => filename.split('/').pop() ?? filename

/**
 * Every file the catalog says `artifact` needs, at exactly the catalog's byte
 * count, under `<data>/diffusion/models`. The fake engine never reads them.
 * Answers the paths written.
 */
export async function writeFakeImageModel(profile: Profile, artifact = IMAGE_ARTIFACT): Promise<string[]> {
  const [familyId, quantId] = artifact.split(':')
  const family = imageCatalogFixture().families.find((f) => f.id === familyId)
  if (!family) throw new Error(`no fixture family ${familyId}`)
  const quant = family.transformer.quants.find((q) => q.id === quantId)
  if (!quant) throw new Error(`no fixture quant ${artifact}`)
  const root = join(profile.dataFolder, 'diffusion', 'models')
  const files: Array<[string, number]> = [[join(root, family.id, basename(quant.filename)), quant.bytes]]
  if (family.vae) files.push([join(root, 'shared', sharedDir(family.vae.repo), basename(family.vae.filename)), family.vae.bytes])
  for (const encoder of family.text_encoders)
    files.push([join(root, 'shared', sharedDir(encoder.repo), basename(encoder.filename)), encoder.bytes])
  for (const [path, bytes] of files) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, Buffer.alloc(bytes, 0x47))
  }
  return files.map(([path]) => path)
}

/** A PNG the page can pick as a source: a solid colour, `w`×`h`, 8-bit RGB. */
export async function writeSourcePng(path: string, w = 256, h = 256): Promise<void> {
  const { deflateSync, crc32 } = await import('node:zlib')
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, tail])
  }
  const stride = w * 3
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1) + 1
    for (let x = 0; x < w; x++) raw.set([200, (x + y) & 255, 90], row + x * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  )
}

/**
 * Every engine tree under `<data>/diffusion/backends`, as `tag/backendId`, plus
 * the `tmp` staging folder when a download left it there. The teardown's list
 * of what a scenario may leave installed.
 */
export async function installedImageEngines(dataFolder: string): Promise<string[]> {
  const root = join(dataFolder, 'diffusion', 'backends')
  const out: string[] = []
  for (const tag of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, tag)
    if (!(await stat(dir)).isDirectory()) continue
    const entries = await readdir(dir).catch(() => [] as string[])
    if (entries.length === 0) out.push(tag)
    for (const backendId of entries) out.push(`${tag}/${backendId}`)
  }
  return out.sort()
}

/** Fake engines still alive under this profile, found by their own argv. */
export function liveFakeSdServers(dataFolder: string): number[] {
  return listProcesses()
    .filter((p) => p.command.includes('fake-sd-server') && p.command.includes(dataFolder))
    .map((p) => p.pid)
}

/** The argv the core last started the fake with. */
export async function sdArgv(engine: Pick<FakeImageEngine, 'argvFile'>): Promise<string[]> {
  return JSON.parse(await readFile(engine.argvFile, 'utf8')) as string[]
}

/** Every pid the fake engine was started as, in order. */
export async function sdPids(engine: Pick<FakeImageEngine, 'pidFile'>): Promise<number[]> {
  return (await readFile(engine.pidFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(Number)
}

export interface DiffusionStatus {
  configured: boolean
  install: { state: string; tag?: string; backendId?: string; dir?: string }
  model: {
    state: string
    loaded: { pid: number; modelId: string; modality?: 'image' | 'video' } | null
    error?: { code: string }
  }
  activeJob: { id: string; state: string } | null
  activeVideoJob?: { id: string; state: string } | null
  outputDir: string
  videoOutputDir?: string
  idleUnloadSecs: number
}

export async function diffusionStatus(dataFolder: string): Promise<DiffusionStatus> {
  const res = await coreRequest(dataFolder, '/diffusion/status')
  if (!res.ok) throw new Error(`diffusion status ${res.status}: ${await res.text()}`)
  return (await res.json()) as DiffusionStatus
}

export async function diffusionJob(dataFolder: string, id: string): Promise<{ state: string; error?: { code: string } } | null> {
  const res = await coreRequest(dataFolder, `/diffusion/jobs/${id}`)
  return ((await res.json()) as { job: { state: string; error?: { code: string } } | null }).job
}

/** The pictures (not thumbnails) in an output folder, by name. */
export async function galleryOnDisk(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.png') && !name.endsWith('.thumb.png'))
    .sort()
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// --- the page ----------------------------------------------------------------

/** The sidebar's label for each workflow (`images:workflow.<id>.label`). */
const WORKFLOW_LABEL: Record<string, string> = {
  create: 'Create',
  transform: 'Transform',
  inpaint: 'Inpaint',
  extend: 'Extend',
  upscale: 'Upscale',
  reference: 'Reference',
  edit: 'Edit',
}

/** Opens Images → `workflow` from the sidebar and waits for the studio. */
export async function openImages(session: Session, workflow = 'create'): Promise<void> {
  const browser = session.app.browser
  const submenu = browser.$('[data-testid="images-submenu"]')
  if (!(await submenu.isDisplayed().catch(() => false))) {
    await browser.$('[data-testid="images-disclosure"]').click()
    await submenu.waitForDisplayed({ timeout: 15_000 })
  }
  await submenu.$(`a=${WORKFLOW_LABEL[workflow]}`).click()
  await browser.$('[data-testid="image-generation-page"]').waitForDisplayed({ timeout: 30_000 })
}

const RUNTIME_CONTROL = '[data-testid="image-model-runtime-indicator"], [data-testid="image-model-runtime-action"]'

async function runtimePhase(browser: Browser): Promise<string | null> {
  const control = browser.$(RUNTIME_CONTROL)
  if (!(await control.isExisting())) return null
  return control.getAttribute('data-phase')
}

/** Presses Run on the selected checkpoint and waits until the core reports it loaded. */
export async function loadImageModel(session: Session, timeoutMs = 60_000): Promise<void> {
  const browser = session.app.browser
  await browser.waitUntil(async () => (await runtimePhase(browser)) === 'idle', {
    timeout: 30_000,
    timeoutMsg: 'no checkpoint offered to run',
  })
  await browser.$(RUNTIME_CONTROL).click()
  await browser.waitUntil(async () => (await runtimePhase(browser)) === 'ready', {
    timeout: timeoutMs,
    timeoutMsg: 'the image model did not become ready',
  })
}

/** Types the prompt and presses Generate. */
export async function generate(session: Session, prompt: string): Promise<void> {
  const browser = session.app.browser
  const input = browser.$('[data-testid="image-prompt-card"] textarea')
  await input.waitForDisplayed({ timeout: 15_000 })
  await input.click()
  await input.setValue(prompt)
  const button = browser.$('[data-testid="image-generate"]')
  await button.waitForEnabled({ timeout: 15_000 })
  await button.click()
}

/** The ids of the gallery tiles on the page, newest first as the grid shows them. */
export async function galleryTiles(session: Session): Promise<string[]> {
  const tiles = await session.app.browser.$$('[data-testid^="gallery-tile-"]')
  const ids: string[] = []
  for (const tile of tiles) ids.push(((await tile.getAttribute('data-testid')) ?? '').replace('gallery-tile-', ''))
  return ids
}

/** Whether the tile's picture actually decoded: the asset protocol served real PNG bytes. */
export async function tileRendered(session: Session, tileId: string): Promise<boolean> {
  return session.app.browser.execute((id: string) => {
    const img = document.querySelector(`[data-testid="gallery-tile-${id}"] img`) as HTMLImageElement | null
    return Boolean(img && img.complete && img.naturalWidth > 0)
  }, tileId)
}
