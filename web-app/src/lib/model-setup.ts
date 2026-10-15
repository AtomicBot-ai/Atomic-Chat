/**
 * Rules for the Hub's PrismML path, kept free of React so they can be tested
 * directly: which files go through the core's model setup instead of a plain
 * download, and how far a setup has come.
 */

import { sanitizeModelId } from '@/lib/utils'
import {
  MODEL_SETUP_FINAL_STAGES,
  type CompatibilityVerdict,
  type ModelSetup,
  type ModelSetupError,
  type ModelSetupPlan,
  type ModelSetupStage,
  type PrismCatalog,
  type PrismFamily,
  type PrismPack,
  type PrismSetupArtifact,
  type PrismSetupBlocker,
  type PrismSetupEngine,
  type PrismSetupPlan,
  type PrismSetupRequest,
} from '@/services/model-setup/types'
import type { CatalogModel } from '@/services/models/types'

/** The provider id of PrismML's llama.cpp. */
export const PRISM_PROVIDER = 'atomic-prism'

export type HubFile = { repo: string; file: string; revision?: string }

/**
 * `owner/repo`, file and revision of a Hugging Face download URL
 * (`https://huggingface.co/<owner>/<repo>/resolve/<revision>/<file>`), or
 * `null` for anything else — a mirror, a local path, a malformed URL.
 */
export function parseHubFileUrl(url: string): HubFile | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'huggingface.co') return null
  const parts = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)
  if (parts.length < 5 || parts[2] !== 'resolve') return null
  const [owner, name, , revision, ...file] = parts
  return { repo: `${owner}/${name}`, file: file.join('/'), revision }
}

/**
 * What the Hub does with a file the core judged:
 * - `setup`: it needs PrismML — the core installs the engine and the file in
 *   one operation (the setup sheet);
 * - `refuse`: no current engine runs it (a legacy layout, an F16 master);
 * - `download`: any llama.cpp engine runs it, or nothing is known yet — the
 *   ordinary download, with the load gate still reading the header later.
 */
export function routeForVerdict(
  verdict: CompatibilityVerdict
): 'setup' | 'refuse' | 'download' {
  switch (verdict.outcome) {
    case 'engine_required':
    case 'engine_update_required':
      return 'setup'
    case 'legacy_artifact':
    case 'unsupported':
      return 'refuse'
    case 'compatible':
      return verdict.provider === PRISM_PROVIDER ? 'setup' : 'download'
    default:
      return 'download'
  }
}

/** Whether a verdict ties the file to PrismML (the Hub's "Requires PrismML"). */
export function requiresPrism(
  verdict: CompatibilityVerdict | null | undefined
) {
  return !!verdict && routeForVerdict(verdict) === 'setup'
}

/**
 * Whether a plan asks nothing of the user: PrismML is on disk, new enough, and
 * nothing blocks the download. Such a setup starts like an ordinary download;
 * any other plan is shown in the setup sheet first.
 */
export function isDownloadOnlyPlan(plan: ModelSetupPlan): boolean {
  return (
    !!plan.engine?.installed &&
    plan.verdict.outcome !== 'engine_update_required' &&
    plan.blockers.length === 0
  )
}

/** A setup that installs no engine: the model and its projector only. */
export function isDownloadOnlySetup(setup: Pick<ModelSetup, 'plan'>): boolean {
  return !setup.plan.engine || setup.plan.engine.installed
}

/** What the core said went wrong, with its details when it gave any. */
export function setupErrorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const { message, details } = error as ModelSetupError
    return details ? `${message} (${details})` : message
  }
  return String(error)
}

export function isFinalSetup(setup: ModelSetup): boolean {
  return MODEL_SETUP_FINAL_STAGES.includes(setup.stage)
}

/** A setup still moving on its own: neither final nor waiting for `resume`. */
export function isRunningSetup(setup: ModelSetup): boolean {
  return !isFinalSetup(setup) && setup.stage !== 'interrupted'
}

/** When this window started, for {@link isStandingReadySetup}. */
const WINDOW_STARTED_AT = Date.now()

/**
 * Whether a `ready` setup still stands for a model on disk. The core keeps the
 * record after the model is deleted, so the app's own delete (its tombstone)
 * ends it. A model the providers do not list ends it too, unless the setup
 * became ready since this window started: the providers are read again only
 * once `ready` arrives, so a fresh model may not be listed yet.
 */
export function isStandingReadySetup(
  setup: ModelSetup,
  model: { installed: boolean; deleted: boolean },
  windowStartedAt = WINDOW_STARTED_AT
): boolean {
  if (setup.stage !== 'ready' || model.deleted) return false
  return model.installed || setup.updated_at >= windowStartedAt
}

/** Keeps the record with the highest revision, as the core asks. */
export function mergeSetup(
  setups: Readonly<Record<string, ModelSetup>>,
  setup: ModelSetup
): Record<string, ModelSetup> {
  const known = setups[setup.setup_id]
  if (known && known.revision >= setup.revision) return { ...setups }
  return { ...setups, [setup.setup_id]: setup }
}

/** The newest setup of one Hub file, by when it was last written. */
export function latestSetupFor(
  setups: Iterable<ModelSetup>,
  file: HubFile
): ModelSetup | undefined {
  let latest: ModelSetup | undefined
  for (const setup of setups) {
    if (setup.request.repo !== file.repo || setup.request.file !== file.file)
      continue
    if (!latest || setup.updated_at > latest.updated_at) latest = setup
  }
  return latest
}

/**
 * The setups the download panel lists: the newest setup of each Hub file while
 * it still runs or waits for `resume`, oldest first.
 */
export function setupsUnderWay(setups: Iterable<ModelSetup>): ModelSetup[] {
  const newest = new Map<string, ModelSetup>()
  for (const setup of setups) {
    const key = `${setup.request.repo}\n${setup.request.file}`
    const known = newest.get(key)
    if (!known || setup.updated_at > known.updated_at) newest.set(key, setup)
  }
  return [...newest.values()]
    .filter((setup) => !isFinalSetup(setup))
    .sort((a, b) => a.created_at - b.created_at)
}

/** The download task of the stage a setup is in, when that stage downloads. */
export function currentSetupTask(setup: ModelSetup): string | undefined {
  switch (setup.stage) {
    case 'installing_engine':
      return setup.task_ids.engine
    case 'downloading_model':
      return setup.task_ids.model
    case 'downloading_projector':
      return setup.task_ids.projector
    default:
      return undefined
  }
}

/** The stages a setup walks, in order; skipped ones are left out. */
export function setupSteps(setup: Pick<ModelSetup, 'plan'>): ModelSetupStage[] {
  const steps: ModelSetupStage[] = ['queued']
  if (setup.plan.engine && !setup.plan.engine.installed)
    steps.push('installing_engine')
  steps.push('downloading_model')
  if (setup.plan.projector) steps.push('downloading_projector')
  steps.push('verifying', 'registering', 'ready')
  return steps
}

export type TaskProgress = { transferred: number; total: number }

/**
 * Bytes done over bytes to do across every download of a setup. A finished
 * stage counts in full; the one running counts what its task reported.
 */
export function setupBytes(
  setup: ModelSetup,
  progress: Readonly<Record<string, TaskProgress>>
): TaskProgress {
  const { plan, task_ids: tasks } = setup
  const downloads: { stage: ModelSetupStage; size: number; task?: string }[] =
    []
  if (plan.engine && !plan.engine.installed)
    downloads.push({
      stage: 'installing_engine',
      size: plan.engine.download_size,
      task: tasks.engine,
    })
  downloads.push({
    stage: 'downloading_model',
    size: plan.model.size,
    task: tasks.model,
  })
  if (plan.projector)
    downloads.push({
      stage: 'downloading_projector',
      size: plan.projector.size,
      task: tasks.projector,
    })

  const steps = setupSteps(setup)
  const at = steps.indexOf(
    setup.stage === 'failed' ||
      setup.stage === 'cancelled' ||
      setup.stage === 'interrupted'
      ? (setup.stopped_at ?? 'queued')
      : setup.stage
  )
  let transferred = 0
  let total = 0
  for (const download of downloads) {
    const reported = download.task ? progress[download.task] : undefined
    const size = download.size || reported?.total || 0
    total += size
    const index = steps.indexOf(download.stage)
    if (at > index) transferred += size
    else if (at === index)
      transferred += Math.min(reported?.transferred ?? 0, size)
  }
  return { transferred, total }
}

/** What {@link planPrismSetup} reads: the request and what the core answered for it. */
export type PrismPlanInput = {
  request: PrismSetupRequest
  /** The core's verdict on the file under `atomic-prism`. */
  verdict: CompatibilityVerdict
  families: readonly PrismFamily[]
  catalog: PrismCatalog
  /** Free bytes on the data drive; `null` when the platform cannot say. */
  freeBytes: number | null
}

/** The build number of a PrismML tag (`prism-b9100-1234567` → 9100); `0` for anything else. */
export function prismTagBuild(tag: string): number {
  const match = /^prism-b(\d+)-[0-9a-f]{7}$/.exec(tag)
  return match ? Number(match[1]) : 0
}

const hubUrl = (repo: string, revision: string, file: string) =>
  `https://huggingface.co/${repo}/resolve/${revision}/${file}`

/**
 * The offered build to install for a file that needs build `minBuild`: the
 * core's own pick when it is new enough, else the newest of the same variant,
 * else the best-ordered one that is. `null` when no offered build is.
 */
function choosePrismPack(
  catalog: PrismCatalog,
  minBuild: number | undefined
): PrismPack | null {
  const fits = catalog.available.filter(
    (pack) => minBuild === undefined || prismTagBuild(pack.version) >= minBuild
  )
  const [version, backend] = (catalog.recommended ?? '').split('/')
  const pick =
    fits.find((pack) => pack.version === version && pack.backend === backend) ??
    fits
      .filter((pack) => pack.backend === backend)
      .sort((a, b) => prismTagBuild(b.version) - prismTagBuild(a.version))[0] ??
    [...fits].sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0]
  return pick ? { version: pick.version, backend: pick.backend } : null
}

function prismEngineOf(
  verdict: CompatibilityVerdict,
  catalog: PrismCatalog,
  blockers: PrismSetupBlocker[]
): PrismSetupEngine | null {
  if (verdict.provider !== PRISM_PROVIDER) return null
  const onDisk = (pack: PrismPack) =>
    catalog.installed.some(
      (p) => p.version === pack.version && p.backend === pack.backend
    )
  if (verdict.outcome === 'compatible') {
    // PrismML already runs it: the build the verdict read, as installed.
    const current =
      catalog.installed.find(
        (pack) => prismTagBuild(pack.version) === verdict.installed_prism_build
      ) ?? catalog.installed[0]
    return current
      ? { ...current, installed: true, download_size: 0 }
      : null
  }
  if (
    verdict.outcome !== 'engine_required' &&
    verdict.outcome !== 'engine_update_required'
  )
    return null
  const pack = choosePrismPack(catalog, verdict.min_prism_build)
  if (!pack) {
    blockers.push({ code: 'no_engine_build' })
    return null
  }
  const installed = onDisk(pack)
  const size =
    catalog.releases
      ?.find((release) => release.tag === pack.version)
      ?.variants.find((variant) => variant.id === pack.backend)?.size ?? 0
  return { ...pack, installed, download_size: installed ? 0 : size }
}

/**
 * What a Bonsai download takes on this machine: the PrismML build when the
 * file needs one that is missing or too old, the file and its default vision
 * projector at the family's pinned revision, the bytes in all and what blocks
 * it. Built in the app from the core's verdict, its Bonsai families, its
 * PrismML catalog and the free disk space; nothing here asks the core.
 */
export function planPrismSetup(input: PrismPlanInput): PrismSetupPlan {
  const { request, verdict, catalog } = input
  const blockers: PrismSetupBlocker[] = []
  if (verdict.outcome === 'unsupported')
    blockers.push({ code: 'unsupported', message: verdict.reason })
  if (verdict.outcome === 'legacy_artifact')
    blockers.push({
      code: 'legacy_artifact',
      message: verdict.reason,
      ...(verdict.replacement ? { replacement: verdict.replacement } : {}),
    })
  const engine = prismEngineOf(verdict, catalog, blockers)

  const family = input.families.find(
    (candidate) =>
      candidate.repo === request.repo &&
      candidate.files.some((file) => file.file === request.file)
  )
  const listed = family?.files.find((file) => file.file === request.file)
  const model: PrismSetupArtifact =
    family && listed
      ? {
          file: listed.file,
          url: hubUrl(family.repo, family.revision, listed.file),
          size: listed.size,
          sha256: listed.sha256,
        }
      : {
          file: request.file,
          url: hubUrl(request.repo, request.revision ?? 'main', request.file),
          size: 0,
        }
  const defaultProjector = family?.projectors.find((p) => p.default)
  const projector: PrismSetupArtifact | null =
    family && defaultProjector && request.include_projector
      ? {
          file: defaultProjector.file,
          url: hubUrl(family.repo, family.revision, defaultProjector.file),
          size: defaultProjector.size,
          sha256: defaultProjector.sha256,
        }
      : null

  const total =
    (engine?.download_size ?? 0) + model.size + (projector?.size ?? 0)
  if (input.freeBytes !== null && total > input.freeBytes)
    blockers.push({
      code: 'insufficient_disk_space',
      needed: total,
      free: input.freeBytes,
    })

  return {
    model_id: request.model_id,
    verdict,
    engine,
    model,
    projector,
    offers_projector: !!defaultProjector,
    total_download_bytes: total,
    free_bytes: input.freeBytes,
    blockers,
  }
}

/**
 * Whether a Bonsai plan asks nothing of the user: the build it needs is on
 * disk (an activation at most) and nothing blocks the download. Such a
 * download starts at once; any other plan is shown in the setup sheet first.
 */
export function isPrismDownloadOnly(plan: PrismSetupPlan): boolean {
  return (
    !!plan.engine?.installed &&
    plan.verdict.outcome !== 'engine_update_required' &&
    plan.blockers.length === 0
  )
}

/** A file size the way the Hub's catalog spells it: `7.2 GB`, `629.2 MB`. */
function catalogFileSize(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/**
 * A Bonsai family as a Model Hub card, for the Hub's PrismML list. Its files
 * are the quants, the recommended one first, and every URL is pinned to the
 * family's revision, which the verdict and the setup read from it. Ids follow
 * a Hugging Face repository's card, so a model reads as downloaded whichever
 * list it was found in.
 */
export function prismFamilyCard(family: PrismFamily): CatalogModel {
  const [owner] = family.repo.split('/', 1)
  const url = (file: string) =>
    `https://huggingface.co/${family.repo}/resolve/${family.revision}/${file}`
  const recommendedFirst = <T extends { default?: boolean }>(items: T[]) =>
    [...items].sort((a, b) => Number(!!b.default) - Number(!!a.default))
  const quants = recommendedFirst(family.files).map((file) => ({
    model_id: `${owner}/${sanitizeModelId(file.file.replace(/\.gguf$/i, ''))}`,
    path: url(file.file),
    file_size: catalogFileSize(file.size),
  }))
  const projectors = recommendedFirst(family.projectors).map((file) => ({
    model_id: sanitizeModelId(file.file.replace(/\.gguf$/i, '')),
    path: url(file.file),
    file_size: catalogFileSize(file.size),
  }))
  return {
    model_name: family.repo,
    developer: owner,
    description: family.title,
    downloads: 0,
    num_quants: quants.length,
    quants,
    num_mmproj: projectors.length,
    mmproj_models: projectors,
    readme: url('README.md'),
  }
}

/** The Hub's PrismML list: the featured families first, in the rules' order otherwise. */
export function prismFamilyCards(families: readonly PrismFamily[]): CatalogModel[] {
  return [...families]
    .sort((a, b) => Number(!!b.featured) - Number(!!a.featured))
    .map(prismFamilyCard)
}
