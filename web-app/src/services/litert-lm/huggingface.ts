/**
 * LiteRT-LM models from Hugging Face (openspec change `add-litert-lm-runtime`, spec
 * `litert-lm-models`, "Модели с Hugging Face дополняют курированный список"): the repositories of
 * conf's organisations tagged `litert-lm`, each read at the commit `main` names, and their
 * `.litertlm` files turned into variants by name — `-gpu`/`_gpu` a GPU file, `_intel_LNL`/`_intel_PTL`
 * an NPU file for that generation, a file without a suffix the CPU's (and the GPU's too when the
 * repository has no GPU file). Web files, other chips' files (`_sm<n>`, `_mt<n>`,
 * `_Google_Tensor_*`, …) and `.task` files are never offered, nor a backend conf does not allow on
 * this platform. Sizes and sha256 are the repository's LFS metadata, so a download is checked like a
 * curated one; the Hub still marks these models "not verified by Atomic Chat".
 *
 * The file-name rule and its test names are the same as `eye-cli`'s (`litert-hf.ts`), so the app
 * and `atc` offer the same variants of a repository (design D4).
 *
 * Speech and embedding repositories (`text-to-speech`, `automatic-speech-recognition`,
 * `feature-extraction`, `sentence-similarity`) are not listed: the provider serves chat only. A
 * repository conf's curated list holds is left to the curated entry. The listing is asked once per
 * Hub session and forgotten after a failure; each repository is read once, when a view first shows
 * it. No token is sent: listing and metadata are public, gated repositories included.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import type { LiteRtLmPlatform } from './curated'
import type { LiteRtLmBackend, LiteRtLmNpu } from './types'

export const HF_HUB = 'https://huggingface.co'

export type LiteRtFileClass =
  | { kind: 'plain'; stem: string }
  | { kind: 'variant'; stem: string; backend: LiteRtLmBackend; npu?: LiteRtLmNpu }

const SUFFIXES: ReadonlyArray<
  [RegExp, Omit<Extract<LiteRtFileClass, { kind: 'variant' }>, 'kind' | 'stem'>]
> = [
  [/[-_]gpu$/i, { backend: 'gpu' }],
  [/_intel_lnl$/i, { backend: 'npu', npu: 'intel-lnl' }],
  [/_intel_ptl$/i, { backend: 'npu', npu: 'intel-ptl' }],
]

/** A file for the browser or for another chip than the ones LiteRT-LM's desktop library runs on. */
const NOT_OFFERED =
  /[-_](web|sm\d+|mt\d+|google_tensor\w*|tensor_g\d+|qualcomm\w*|qnn\w*|mediatek\w*|samsung\w*|exynos\w*|intel_\w+)$/i

/** What one file of a repository is, by its name; `null` for a file never offered. */
export function classifyLiteRtFile(path: string): LiteRtFileClass | null {
  const name = path.split('/').at(-1) ?? ''
  if (!name.endsWith('.litertlm')) return null
  const base = name.slice(0, -'.litertlm'.length)
  for (const [suffix, variant] of SUFFIXES) {
    const match = suffix.exec(base)
    // Another chip's file may end in `_gpu` too (`_mt6993_gpu`): its stem still names that chip.
    if (match) {
      return NOT_OFFERED.test(base.slice(0, match.index))
        ? null
        : { kind: 'variant', stem: base.slice(0, match.index), ...variant }
    }
  }
  if (NOT_OFFERED.test(base)) return null
  return { kind: 'plain', stem: base }
}

export interface HfFile {
  path: string
  size: number
  /** The LFS sha256; `null` for a file the Hub keeps outside LFS (never a model). */
  sha256: string | null
}

export interface HfVariant {
  id: string
  backend: LiteRtLmBackend
  npu?: LiteRtLmNpu
  file: { path: string; size: number; sha256: string }
}

const ORDER: Record<LiteRtLmBackend, number> = { npu: 0, gpu: 1, cpu: 2 }

const slug = (stem: string) =>
  stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')

/** A repository's files as variants, NPU first, then GPU, then CPU; only the backends in `allowed`. */
export function hfVariants(files: readonly HfFile[], allowed: readonly LiteRtLmBackend[]): HfVariant[] {
  const classified = files.flatMap((file) => {
    const kind = file.sha256 ? classifyLiteRtFile(file.path) : null
    return kind
      ? [{ file: { path: file.path, size: file.size, sha256: file.sha256 as string }, kind }]
      : []
  })
  const hasGpuFile = classified.some(({ kind }) => kind.kind === 'variant' && kind.backend === 'gpu')
  const variants: HfVariant[] = []
  const add = (stem: string, backend: LiteRtLmBackend, file: HfVariant['file'], npu?: LiteRtLmNpu) => {
    if (!allowed.includes(backend)) return
    const id = `${slug(stem)}-${backend}${npu ? `-${npu}` : ''}`
    if (!variants.some((variant) => variant.id === id)) {
      variants.push({ id, backend, ...(npu ? { npu } : {}), file })
    }
  }
  for (const { file, kind } of classified) {
    if (kind.kind === 'variant') add(kind.stem, kind.backend, file, kind.npu)
    else {
      add(kind.stem, 'cpu', file)
      if (!hasGpuFile) add(kind.stem, 'gpu', file)
    }
  }
  return variants.sort((a, b) => ORDER[a.backend] - ORDER[b.backend])
}

/**
 * `variants` with ids no curated variant holds: a taken id is named by its repository
 * (`<name>-<id>`), so the id a view shows does not depend on what else that view found.
 */
export function uniqueHfIds(
  variants: readonly HfVariant[],
  repo: string,
  taken: ReadonlySet<string>
): HfVariant[] {
  const name = slug(repo.split('/').at(-1) ?? repo)
  return variants.map((variant) => (taken.has(variant.id) ? { ...variant, id: `${name}-${variant.id}` } : variant))
}

export interface LiteRtLmHfVariant extends HfVariant {
  /** The host platform: conf allowed this backend here, nothing more is known. */
  platforms: LiteRtLmPlatform[]
}

/** A Hugging Face repository as the Hub offers it. */
export interface LiteRtLmHfModel {
  /** `<org>/<name>`. */
  repo: string
  /** The repository's name. */
  name: string
  /** The commit `main` named when it was read; every file is downloaded from it. */
  revision: string
  gated: boolean
  license: string | null
  variants: LiteRtLmHfVariant[]
}

export interface HfLiteRtResult {
  models: LiteRtLmHfModel[]
  /** The Hub could not be listed; the Hub shows the curated list alone, with a note. */
  unavailable: boolean
  error?: string
}

export interface HfLiteRtOptions {
  /** conf's `huggingface.orgs`. */
  orgs: readonly string[]
  /** conf's `huggingface.backends` for this platform. */
  allowed: readonly LiteRtLmBackend[]
  platform: LiteRtLmPlatform
  /** conf's curated models: their repositories are not listed again, their variant ids not reused. */
  curated: ReadonlyArray<{ repo: string; variants: ReadonlyArray<{ id: string }> }>
  /** Words the repository's name must hold; empty: the most downloaded ones. */
  query?: string
  fetchJson?: (url: string) => Promise<unknown>
}

/** Repositories read for one view: a search's matches, or the most downloaded ones. */
const SHOWN = 50
const CONCURRENCY = 8
const NOT_CHAT = new Set([
  'text-to-speech',
  'automatic-speech-recognition',
  'feature-extraction',
  'sentence-similarity',
])

type ListedRepository = { id: string }
type Revision = {
  sha?: unknown
  gated?: unknown
  cardData?: { license?: unknown } | null
  tags?: unknown
  siblings?: Array<{ rfilename?: unknown; size?: unknown; lfs?: { sha256?: unknown; size?: unknown } | null }>
}
type Repository = { repo: string; revision: string; gated: boolean; license: string | null; files: HfFile[] }

let listings = new Map<string, Promise<ListedRepository[]>>()
let repositories = new Map<string, Promise<Repository | null>>()

/** Forget what this Hub session read (tests; a new session starts empty anyway). */
export function resetHfLiteRtCache(): void {
  listings = new Map()
  repositories = new Map()
}

const defaultFetchJson = async (url: string): Promise<unknown> => {
  // The Tauri HTTP plugin, like the other Hub calls: no CORS question, no webview cookies.
  const fetcher = typeof IS_TAURI !== 'undefined' && IS_TAURI ? (fetchTauri as typeof fetch) : fetch
  const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Hugging Face answered ${response.status} for ${url}`)
  return (await response.json()) as unknown
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function listOrg(org: string, fetchJson: (url: string) => Promise<unknown>): Promise<ListedRepository[]> {
  let listing = listings.get(org)
  if (!listing) {
    const params = new URLSearchParams({
      author: org,
      filter: 'litert-lm',
      sort: 'downloads',
      direction: '-1',
      limit: '1000',
    })
    listing = fetchJson(`${HF_HUB}/api/models?${params}`).then((answer) => {
      if (!Array.isArray(answer)) throw new Error('Hugging Face answered its model listing in another shape.')
      return (answer as Array<{ id?: unknown; pipeline_tag?: unknown }>).flatMap((entry) =>
        typeof entry.id === 'string' && !NOT_CHAT.has(entry.pipeline_tag as string) ? [{ id: entry.id }] : []
      )
    })
    // A failure is forgotten: the next view asks again.
    listing.catch(() => listings.delete(org))
    listings.set(org, listing)
  }
  return listing
}

function readRepository(repo: string, fetchJson: (url: string) => Promise<unknown>): Promise<Repository | null> {
  let read = repositories.get(repo)
  if (!read) {
    read = fetchJson(`${HF_HUB}/api/models/${repo}/revision/main?blobs=true`).then(
      (answer) => {
        const revision = answer as Revision | null
        if (!revision || typeof revision.sha !== 'string') return null
        const tag = Array.isArray(revision.tags)
          ? revision.tags.find((t): t is string => typeof t === 'string' && t.startsWith('license:'))
          : undefined
        const license =
          typeof revision.cardData?.license === 'string'
            ? revision.cardData.license
            : (tag?.slice('license:'.length) ?? null)
        return {
          repo,
          revision: revision.sha,
          gated: revision.gated !== undefined && revision.gated !== false,
          license,
          files: (revision.siblings ?? []).flatMap((sibling) =>
            typeof sibling.rfilename === 'string'
              ? [
                  {
                    path: sibling.rfilename,
                    size: Number(sibling.lfs?.size ?? sibling.size ?? 0),
                    sha256: typeof sibling.lfs?.sha256 === 'string' ? sibling.lfs.sha256 : null,
                  },
                ]
              : []
          ),
        }
      },
      // One repository the Hub does not answer for is left out of the view, and asked again next time.
      () => {
        repositories.delete(repo)
        return null
      }
    )
    repositories.set(repo, read)
  }
  return read
}

/**
 * The Hugging Face models of the LiteRT-LM format for this platform. Never throws: a listing that
 * fails gives no models and `unavailable`.
 */
export async function fetchHfLiteRtModels(options: HfLiteRtOptions): Promise<HfLiteRtResult> {
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const curatedRepos = new Set(options.curated.map((model) => model.repo.toLowerCase()))
  const taken = new Set(options.curated.flatMap((model) => model.variants.map((variant) => variant.id)))
  const words = (options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)

  let listed: ListedRepository[]
  try {
    listed = (await Promise.all(options.orgs.map((org) => listOrg(org, fetchJson)))).flat()
  } catch (error) {
    return { models: [], unavailable: true, error: messageOf(error) }
  }

  const shown = [...new Set(listed.map((entry) => entry.id))]
    .filter((repo) => !curatedRepos.has(repo.toLowerCase()))
    .filter((repo) => words.every((word) => repo.toLowerCase().includes(word)))
    .slice(0, SHOWN)

  const read: Array<Repository | null> = []
  for (let start = 0; start < shown.length; start += CONCURRENCY) {
    read.push(...(await Promise.all(shown.slice(start, start + CONCURRENCY).map((repo) => readRepository(repo, fetchJson)))))
  }

  const models = read.flatMap((repository): LiteRtLmHfModel[] => {
    if (!repository) return []
    const variants = uniqueHfIds(hfVariants(repository.files, options.allowed), repository.repo, taken)
    if (variants.length === 0) return []
    return [
      {
        repo: repository.repo,
        name: repository.repo.split('/').at(-1) ?? repository.repo,
        revision: repository.revision,
        gated: repository.gated,
        license: repository.license,
        variants: variants.map((variant) => ({ ...variant, platforms: [options.platform] })),
      },
    ]
  })
  return { models, unavailable: false }
}
