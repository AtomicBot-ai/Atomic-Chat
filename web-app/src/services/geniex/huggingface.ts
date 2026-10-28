/**
 * GenieX's GGUF models from Hugging Face (openspec change `add-geniex-runtime`, spec
 * `geniex-models`, "GGUF-модели с Hugging Face дополняют курированный список"): the GGUF
 * repositories the llama.cpp provider's search knows (the app's model catalog, searched locally by
 * `model-search.ts`), each read at the commit `main` names, with the one file of a quantization
 * conf allows (`huggingface.quantizations`, `Q4_0` first), the projector beside it when the
 * repository has one, and the devices conf allows on this platform (`huggingface.backends`). Sizes
 * and sha256 are the repository's LFS metadata, so a download is checked like a curated one; the Hub
 * still marks these models "Hugging Face, not verified by Atomic Chat".
 *
 * A repository conf's curated list holds is left to the curated entry. Each repository is read once
 * per Hub session, when a view first shows it; a read that fails is forgotten and asked again next
 * time. No token is sent: the tree is public, gated repositories included. AI Hub bundles never come
 * from here: their source is the curated list alone.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import type { GeniexPlatform } from './curated'
import type { GeniexDevice, GeniexHubFile } from './types'

export const HF_HUB = 'https://huggingface.co'

export type GgufFileClass = { kind: 'model'; quantization: string } | { kind: 'mmproj' }

/** `-00001-of-00002`: one model split over several files, which the host does not load. */
const SHARD = /-\d{5}-of-\d{5}$/i

/**
 * What one file of a repository is, by its name: the model at one of `quantizations` (as conf spells
 * them; the name's case does not matter, Google's QAT files say `q4_0`), the projector, or nothing
 * the Hub offers.
 */
export function classifyGgufFile(path: string, quantizations: readonly string[]): GgufFileClass | null {
  const name = path.split('/').at(-1) ?? ''
  if (!/\.gguf$/i.test(name)) return null
  const stem = name.slice(0, -'.gguf'.length)
  if (SHARD.test(stem)) return null
  if (/mmproj/i.test(stem)) return { kind: 'mmproj' }
  const tokens = stem.split(/[-_.]/).map((token) => token.toUpperCase())
  for (const quantization of quantizations) {
    // A quantization is itself `_`-joined (`Q4_K_M`): its parts must follow each other in the name.
    const parts = quantization.toUpperCase().split('_')
    for (let start = 0; start + parts.length <= tokens.length; start++) {
      if (parts.every((part, index) => tokens[start + index] === part)) {
        return { kind: 'model', quantization }
      }
    }
  }
  return null
}

/** A file as Hugging Face's revision answer lists it. */
export interface HfSibling {
  rfilename: string
  size?: number | null
  lfs?: { sha256?: string; size?: number } | null
}

export interface HfGgufPick {
  quantization: string
  file: GeniexHubFile
  mmproj?: GeniexHubFile
}

const asFile = (sibling: HfSibling): GeniexHubFile | null => {
  const sha256 = sibling.lfs?.sha256
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  const size = Number(sibling.lfs?.size ?? sibling.size ?? 0)
  if (!Number.isInteger(size) || size <= 0) return null
  return { path: sibling.rfilename, size, sha256 }
}

/**
 * The model file to offer — the first of `quantizations` the repository has, with its LFS size and
 * sha256 — and the projector beside it (an F16 one when there are several). `null` when the
 * repository has no such file, or only one without LFS metadata.
 */
export function hfGgufFiles(siblings: readonly HfSibling[], quantizations: readonly string[]): HfGgufPick | null {
  const models = new Map<string, GeniexHubFile>()
  const projectors: GeniexHubFile[] = []
  for (const sibling of siblings) {
    const kind = classifyGgufFile(sibling.rfilename, quantizations)
    if (!kind) continue
    const file = asFile(sibling)
    if (!file) continue
    if (kind.kind === 'mmproj') projectors.push(file)
    else if (!models.has(kind.quantization)) models.set(kind.quantization, file)
  }
  const quantization = quantizations.find((q) => models.has(q))
  if (!quantization) return null
  const mmproj = projectors.find((file) => /f16/i.test(file.path)) ?? projectors[0]
  return {
    quantization,
    file: models.get(quantization) as GeniexHubFile,
    ...(mmproj ? { mmproj } : {}),
  }
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')

/**
 * The id a Hugging Face model lists and downloads under: its repository's name, or
 * `<organisation>-<name>` when a curated model already holds that id, so the folder
 * `<data>/geniex/models/<id>` is one model's.
 */
export function geniexHfModelId(repo: string, taken: ReadonlySet<string>): string {
  const [org, name] = repo.split('/')
  const id = slug(name ?? repo)
  return taken.has(id) ? `${slug(org)}-${id}` : id
}

/** A Hugging Face repository as the Hub offers it. */
export interface GeniexHfModel {
  /** The id the model lists and downloads under (`geniexHfModelId`). */
  model_id: string
  /** `<org>/<name>`. */
  repo: string
  /** The repository's name. */
  name: string
  /** The commit `main` named when it was read; every file is downloaded from it. */
  revision: string
  gated: boolean
  license: string | null
  quantization: string
  file: GeniexHubFile
  mmproj?: GeniexHubFile
  /** conf's devices for this platform: nothing more is known before the core checks the file. */
  devices: GeniexDevice[]
  platforms: GeniexPlatform[]
}

export interface HfGeniexResult {
  models: GeniexHfModel[]
  /** No repository could be read; the Hub shows the curated list alone, with a note. */
  unavailable: boolean
  error?: string
}

export interface HfGeniexOptions {
  /** GGUF repositories the catalog search found, most relevant first. */
  candidates: readonly string[]
  /** conf's `huggingface.quantizations`, in order of preference. */
  quantizations: readonly string[]
  /** conf's `huggingface.backends` for this platform. */
  allowed: readonly GeniexDevice[]
  platform: GeniexPlatform
  /** conf's curated models: their repositories are not listed again, their ids not reused. */
  curated: ReadonlyArray<{ id: string; repo?: string }>
  fetchJson?: (url: string) => Promise<unknown>
}

/** Repositories read for one view. */
const SHOWN = 50
const CONCURRENCY = 8

type Revision = {
  sha?: unknown
  gated?: unknown
  cardData?: { license?: unknown } | null
  tags?: unknown
  siblings?: HfSibling[]
}
type Repository = { repo: string; revision: string; gated: boolean; license: string | null; siblings: HfSibling[] }

let repositories = new Map<string, Promise<Repository | null>>()

/** Forget what this Hub session read (tests; a new session starts empty anyway). */
export function resetHfGeniexCache(): void {
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

function readRepository(
  repo: string,
  fetchJson: (url: string) => Promise<unknown>
): Promise<Repository | null> {
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
          siblings: (revision.siblings ?? []).filter((sibling) => typeof sibling?.rfilename === 'string'),
        }
      },
      // One repository the Hub does not answer for is left out of the view, and asked again next time.
      (error: unknown) => {
        repositories.delete(repo)
        throw error
      }
    )
    repositories.set(repo, read)
  }
  return read
}

/**
 * The Hugging Face GGUF models of the GenieX format for this platform, in the candidates' order.
 * Never throws: when no repository could be read the result says Hugging Face is unavailable.
 */
export async function fetchHfGeniexModels(options: HfGeniexOptions): Promise<HfGeniexResult> {
  const fetchJson = options.fetchJson ?? defaultFetchJson
  // conf closed every device, or every quantization, for Hugging Face models: nothing to offer, no reads.
  if (options.allowed.length === 0 || options.quantizations.length === 0) return { models: [], unavailable: false }
  const curatedRepos = new Set(options.curated.flatMap((model) => (model.repo ? [model.repo.toLowerCase()] : [])))
  const taken = new Set(options.curated.map((model) => model.id))
  const shown = [...new Set(options.candidates)]
    .filter((repo) => !curatedRepos.has(repo.toLowerCase()))
    .slice(0, SHOWN)

  const read: Array<Repository | null> = []
  let failures = 0
  let lastError: string | undefined
  for (let start = 0; start < shown.length; start += CONCURRENCY) {
    read.push(
      ...(await Promise.all(
        shown.slice(start, start + CONCURRENCY).map((repo) =>
          readRepository(repo, fetchJson).catch((error: unknown) => {
            failures++
            lastError = messageOf(error)
            return null
          })
        )
      ))
    )
  }
  if (shown.length > 0 && failures === shown.length) {
    return { models: [], unavailable: true, ...(lastError ? { error: lastError } : {}) }
  }

  const models = read.flatMap((repository): GeniexHfModel[] => {
    if (!repository) return []
    const pick = hfGgufFiles(repository.siblings, options.quantizations)
    if (!pick) return []
    const model_id = geniexHfModelId(repository.repo, taken)
    taken.add(model_id)
    return [
      {
        model_id,
        repo: repository.repo,
        name: repository.repo.split('/').at(-1) ?? repository.repo,
        revision: repository.revision,
        gated: repository.gated,
        license: repository.license,
        quantization: pick.quantization,
        file: pick.file,
        ...(pick.mmproj ? { mmproj: pick.mmproj } : {}),
        devices: [...options.allowed],
        platforms: [options.platform],
      },
    ]
  })
  return { models, unavailable: false }
}
