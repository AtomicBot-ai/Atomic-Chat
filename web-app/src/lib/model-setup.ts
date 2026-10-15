/**
 * Rules for the Hub's PrismML path, kept free of React so they can be tested
 * directly: which files need PrismML, and what a Bonsai download takes on this
 * machine, planned from what the core reports.
 */

import { sanitizeModelId } from '@/lib/utils'
import type {
  CompatibilityVerdict,
  CoreCallError,
  PrismCatalog,
  PrismFamily,
  PrismPack,
  PrismSetupArtifact,
  PrismSetupBlocker,
  PrismSetupEngine,
  PrismSetupPlan,
  PrismSetupRequest,
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
 * - `setup`: it needs PrismML — the app installs the engine through the core
 *   when needed and downloads the file under PrismML (the setup sheet);
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

/** What the core said went wrong, with its details when it gave any. */
export function setupErrorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const { message, details } = error as CoreCallError
    return details ? `${message} (${details})` : message
  }
  return String(error)
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
 * family's revision, which the verdict and the download read from it. Ids follow
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
