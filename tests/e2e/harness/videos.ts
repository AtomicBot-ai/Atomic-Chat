/**
 * Video generation without gigabytes: the core's scripted `sd-server` in its
 * `vid_gen` mode installed as this profile's engine, catalog video "models"
 * whose files are a few bytes of exactly the size the catalog says, and the
 * caches the webview would have fetched, seeded so the Video page opens
 * offline with a model to run. Built on harness/images.ts: one engine serves
 * both pages, so the install and the model files are the same shape.
 */
import { readdir, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser } from 'webdriverio'
import { coreRequest } from './core.js'
import {
  IMAGE_ARTIFACT,
  IMAGE_ENGINE_TAG,
  imageCatalogFixture,
  imageManifestFixture,
  installFakeImageEngine,
  type FakeImageEngine,
  type FakeSdOptions,
} from './images.js'
import type { Profile } from './profile.js'
import type { Session } from './session.js'

export const VIDEO_FAMILY = 'ltx-2'
export const VIDEO_QUANT = 'q4_k'
export const VIDEO_ARTIFACT = `${VIDEO_FAMILY}:${VIDEO_QUANT}`
export const WAN_FAMILY = 'wan2.2-ti2v-5b'
export const WAN_ARTIFACT = `${WAN_FAMILY}:${VIDEO_QUANT}`

const SHARED_REPO = 'e2e/shared'

type CatalogFile = { repo: string; filename: string; bytes: number; field?: string }
type VideoCatalogFamily = {
  id: string
  name: string
  modality: 'video'
  engines: string[]
  transformer: { repo: string; quants: Array<{ id: string; label: string; filename: string; bytes: number; recommended?: boolean }> }
  vae?: CatalogFile
  audio_vae?: CatalogFile
  text_encoders: CatalogFile[]
  defaults: { steps: number; cfg_scale: number; width: number; height: number; sampling_method?: string; flow_shift?: number; sigmas?: number[] }
  ranges: { steps: [number, number]; dims: [number, number]; dim_multiple: number }
  video: { fps: number; frame_step: number; frame_offset: number; frames: number; frame_range: [number, number]; resolution_presets: [number, number][] }
  capabilities: { negative_prompt: boolean; guidance: boolean; workflows: string[] }
}

/**
 * The two video families, as `atomic-chat-conf/models/diffusion.json` lists
 * them, with byte counts a test can write out and a frame default the fake
 * renders in a blink. LTX brings the audio VAE and the connectors, Wan the
 * umT5 encoder and a negative prompt.
 */
export function videoCatalogFixture(): { schema_version: number; updated_at: string; families: Array<VideoCatalogFamily | ReturnType<typeof imageCatalogFixture>['families'][number]> } {
  const common = {
    modality: 'video' as const,
    engines: ['sdcpp'],
    // The fake paints one 64×64 clip whatever it is asked; keep the presets inside its world.
    ranges: { steps: [1, 50] as [number, number], dims: [64, 2048] as [number, number], dim_multiple: 16 },
    video: {
      fps: 24,
      frame_step: 8,
      frame_offset: 1,
      frames: 9,
      frame_range: [9, 257] as [number, number],
      resolution_presets: [[256, 256], [64, 64]] as [number, number][],
    },
  }
  const image = imageCatalogFixture()
  return {
    schema_version: 1,
    updated_at: '2026-09-23T00:00:00Z',
    families: [
      ...image.families,
      {
        ...common,
        id: VIDEO_FAMILY,
        name: 'LTX-2.3 Distilled',
        transformer: {
          repo: 'e2e/LTX-2.3',
          quants: [{ id: VIDEO_QUANT, label: 'Q4_K', filename: 'distilled/ltx-2.3-q4_k.gguf', bytes: 72, recommended: true }],
        },
        vae: { repo: SHARED_REPO, filename: 'ltx-video-vae.safetensors', bytes: 36 },
        audio_vae: { repo: SHARED_REPO, filename: 'ltx-audio-vae.safetensors', bytes: 20 },
        text_encoders: [
          { repo: SHARED_REPO, filename: 'gemma-3-12b.gguf', bytes: 52, field: 'llm' },
          { repo: SHARED_REPO, filename: 'ltx-connectors.safetensors', bytes: 24, field: 'embeddings_connectors' },
        ],
        defaults: { steps: 2, cfg_scale: 1, sampling_method: 'euler', width: 256, height: 256, sigmas: [1, 0.5] },
        capabilities: { negative_prompt: false, guidance: false, workflows: ['create'] },
      },
      {
        ...common,
        video: { ...common.video, frame_step: 4, frame_range: [5, 241] as [number, number] },
        id: WAN_FAMILY,
        name: 'Wan 2.2 TI2V 5B',
        transformer: {
          repo: 'e2e/Wan2.2-TI2V-5B',
          quants: [{ id: VIDEO_QUANT, label: 'Q4_K', filename: 'wan2.2-ti2v-5b-q4_k.gguf', bytes: 60, recommended: true }],
        },
        vae: { repo: SHARED_REPO, filename: 'wan2.2-vae.safetensors', bytes: 30 },
        text_encoders: [{ repo: SHARED_REPO, filename: 'umt5-xxl.gguf', bytes: 44, field: 't5xxl' }],
        defaults: { steps: 2, cfg_scale: 5, sampling_method: 'euler', flow_shift: 5, width: 256, height: 256 },
        capabilities: { negative_prompt: true, guidance: false, workflows: ['create'] },
      },
    ],
  }
}

export interface VideoSeedOptions {
  /** The checkpoint the Video page shows as selected; `null` for none. */
  selected?: string | null
  /** Overrides on the persisted image settings (`useImageSetting`): the shared engine and residency rules. */
  setting?: Record<string, unknown>
  /** Overrides on the persisted video settings (`useVideoSetting`). */
  videoSetting?: Record<string, unknown>
  /** Overrides on the persisted video form (`useVideoForm`): `steps`, `frames`, `width`, `height`, … */
  form?: Record<string, unknown>
}

/**
 * What to put in the webview's localStorage before the first page script: the
 * catalog (image and video families) and manifest caches, the image settings
 * with the tour already done, and the video selection.
 */
export function videoSeed(options: VideoSeedOptions = {}): Record<string, string> {
  const now = String(Date.now())
  const seed: Record<string, string> = {
    atomic_diffusion_catalog_cache_v1: JSON.stringify(videoCatalogFixture()),
    atomic_diffusion_catalog_cache_ts_v1: now,
    atomic_sdcpp_manifest_cache_v1: JSON.stringify(imageManifestFixture()),
    atomic_sdcpp_manifest_cache_ts_v1: now,
    'setting-images': JSON.stringify({
      state: {
        setupCompleted: true,
        selectedArtifactId: IMAGE_ARTIFACT,
        evictChatModel: 'whenNeeded',
        idleUnloadMinutes: 0,
        outputDir: null,
        ...options.setting,
      },
      version: 1,
    }),
    'setting-videos': JSON.stringify({
      state: {
        selectedArtifactId: options.selected === undefined ? VIDEO_ARTIFACT : options.selected,
        advancedOpen: false,
        outputDir: null,
        ...options.videoSetting,
      },
      version: 1,
    }),
  }
  if (options.form) {
    seed['video-form'] = JSON.stringify({
      state: { width: 256, height: 256, frames: 9, steps: 2, cfgScale: 1, guidance: null, seedText: '', negativeOpen: false, ...options.form },
      version: 1,
    })
  }
  return seed
}

/**
 * The scripted `sd-server` as a video engine: the image install with
 * `supported_modes: ['vid_gen']`, so the core loads video checkpoints on it
 * and refuses image ones. Call it from `prepare`.
 */
export async function installFakeVideoEngine(
  profile: Profile,
  options: FakeSdOptions & { tag?: string } = {}
): Promise<FakeImageEngine> {
  return installFakeImageEngine(profile, { modes: ['vid_gen'], ...options })
}

/** `provider/name` → `provider--name`, the way the app lays shared files out. */
const sharedDir = (repo: string) => repo.replace(/\//g, '--')
const basename = (filename: string) => filename.split('/').pop() ?? filename

/**
 * Every file the catalog says `artifact` needs — transformer, both VAEs, the
 * text encoders — at exactly the catalog's byte count, under
 * `<data>/diffusion/models`. The fake engine never reads them. Answers the
 * paths written.
 */
export async function writeFakeVideoModel(profile: Profile, artifact = VIDEO_ARTIFACT): Promise<string[]> {
  const [familyId, quantId] = artifact.split(':')
  const family = videoCatalogFixture().families.find((f) => f.id === familyId) as VideoCatalogFamily | undefined
  if (!family) throw new Error(`no fixture family ${familyId}`)
  const quant = family.transformer.quants.find((q) => q.id === quantId)
  if (!quant) throw new Error(`no fixture quant ${artifact}`)
  const root = join(profile.dataFolder, 'diffusion', 'models')
  const files: Array<[string, number]> = [[join(root, family.id, basename(quant.filename)), quant.bytes]]
  for (const side of [family.vae, family.audio_vae, ...family.text_encoders]) {
    if (side) files.push([join(root, 'shared', sharedDir(side.repo), basename(side.filename)), side.bytes])
  }
  for (const [path, bytes] of files) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, Buffer.alloc(bytes, 0x47))
  }
  return files.map(([path]) => path)
}

export { IMAGE_ENGINE_TAG as VIDEO_ENGINE_TAG }

export async function videoJob(dataFolder: string, id: string): Promise<{ state: string; error?: { code: string } } | null> {
  const res = await coreRequest(dataFolder, `/diffusion/video/jobs/${id}`)
  return ((await res.json()) as { job: { state: string; error?: { code: string } } | null }).job
}

/** The clips in a video folder, by name; recipes and posters are not clips. */
export async function videoGalleryOnDisk(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.webm')).sort()
}

/** The posters the app rendered into a video folder, by name. */
export async function videoPostersOnDisk(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.thumb.png')).sort()
}

// --- the page ----------------------------------------------------------------

/** Opens Video from the sidebar and waits for the studio. */
export async function openVideos(session: Session): Promise<void> {
  const browser = session.app.browser
  await browser.$('[data-testid="videos-link"]').click()
  await browser.$('[data-testid="video-generation-page"]').waitForDisplayed({ timeout: 30_000 })
}

const RUNTIME_CONTROL = '[data-testid="image-model-runtime-indicator"], [data-testid="image-model-runtime-action"]'

async function runtimePhase(browser: Browser): Promise<string | null> {
  const control = browser.$(RUNTIME_CONTROL)
  if (!(await control.isExisting())) return null
  return control.getAttribute('data-phase')
}

/** Presses Run on the selected video checkpoint and waits until the core reports it loaded. */
export async function loadVideoModel(session: Session, timeoutMs = 60_000): Promise<void> {
  const browser = session.app.browser
  await browser.waitUntil(async () => (await runtimePhase(browser)) === 'idle', {
    timeout: 30_000,
    timeoutMsg: 'no video checkpoint offered to run',
  })
  await browser.$(RUNTIME_CONTROL).click()
  await browser.waitUntil(async () => (await runtimePhase(browser)) === 'ready', {
    timeout: timeoutMs,
    timeoutMsg: 'the video model did not become ready',
  })
}

/** Types the prompt and presses Generate on the Video page. */
export async function generateVideo(session: Session, prompt: string): Promise<void> {
  const browser = session.app.browser
  const input = browser.$('[data-testid="video-prompt-card"] textarea')
  await input.waitForDisplayed({ timeout: 15_000 })
  await input.click()
  await input.setValue(prompt)
  const button = browser.$('[data-testid="image-generate"]')
  await button.waitForEnabled({ timeout: 15_000 })
  await button.click()
}

/** The ids of the video tiles on the page, newest first as the grid shows them. */
export async function videoTiles(session: Session): Promise<string[]> {
  const tiles = await session.app.browser.$$('[data-testid^="video-tile-"]')
  const ids: string[] = []
  for (const tile of tiles) {
    const id = ((await tile.getAttribute('data-testid')) ?? '').replace('video-tile-', '')
    if (id !== 'poster-missing' && id !== 'duration') ids.push(id)
  }
  return ids
}

/** Whether the tile's poster decoded: the app rendered it and the asset protocol served it. */
export async function posterRendered(session: Session, tileId: string): Promise<boolean> {
  return session.app.browser.execute((id: string) => {
    const img = document.querySelector(`[data-testid="video-tile-${id}"] img`) as HTMLImageElement | null
    return Boolean(img && img.complete && img.naturalWidth > 0)
  }, tileId)
}

/**
 * Whether the viewer's player has the clip: metadata read over the asset
 * protocol and a frame size, which is the webview decoding the WebM itself.
 */
export async function videoRendered(session: Session): Promise<boolean> {
  return session.app.browser.execute(() => {
    const player = document.querySelector('[data-testid="video-player"]') as HTMLVideoElement | null
    return Boolean(player && player.readyState >= 1 && player.videoWidth > 0)
  })
}
