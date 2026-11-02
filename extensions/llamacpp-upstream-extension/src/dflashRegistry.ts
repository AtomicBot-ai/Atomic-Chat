import { atomicAuxiliaryFile } from '@janhq/core'
/**
 * @file Static registry mapping a DFlash *target* model to the separate DFlash
 * *draft* GGUF it needs for upstream llama.cpp multi-layer draft speculative
 * decoding (`--model-draft <draft> --spec-type draft-dflash`, PR
 * ggml-org/llama.cpp#22105, commit d1b34251b, first tagged release `b9831`).
 *
 * DFlash ships the draft as a second, small GGUF that must be downloaded next
 * to the target model (the same way `mmproj` and Gemma 4 MTP heads are handled
 * — see gemmaMtpRegistry.ts). The upstream MLX DFlash drafts are published as
 * safetensors and would need conversion; these entries instead point at
 * GGUF repos built for mainline llama.cpp so the file can be consumed
 * directly. Fork-only `dflash-draft` / `qwen35-dflash-draft` architectures
 * are deliberately excluded.
 *
 * Draft files were verified against the live Hugging Face API (sha256 + size
 * pinned so the downloader validates them). Atomic Chat's verified Q8_0
 * conversions are the default for every target-model quantization when
 * available; compatible community conversions provide the remaining draft
 * choices and cover families without an Atomic Chat conversion.
 */

export interface DflashDraft {
  /** Quantization label shown in the settings picker. */
  quant: string
  /** Hugging Face repo id that hosts the DFlash draft GGUF. */
  repo: string
  /** Exact filename of the draft inside the repo. */
  draftFilename: string
  /** Pinned sha256 of the draft file (lowercase hex) for download validation. */
  draftSha256?: string
  /** Pinned byte size of the draft file for download validation. */
  draftSize: number
  revision?: string
}

interface DflashRegistryEntry {
  /**
   * Predicate over a normalized (lowercased) model id that decides whether the
   * id refers to this target family. Kept deliberately strict so unrelated
   * Qwen sizes never resolve a draft.
   */
  matches: (normalizedId: string) => boolean
  drafts: readonly Pick<DflashDraft, 'quant' | 'repo' | 'draftFilename'>[]
}

function hasQwenFamily(normalizedId: string, family: '35' | '36'): boolean {
  const compact = normalizedId.replace(/[\s._-]+/g, '')
  return compact.includes(`qwen${family}`)
}

function compactId(normalizedId: string): string {
  return normalizedId.replace(/[\s._-]+/g, '')
}

function isBaseQwen3(normalizedId: string): boolean {
  const compact = compactId(normalizedId)
  return (
    compact.includes('qwen3') &&
    !compact.includes('qwen35') &&
    !compact.includes('qwen36') &&
    !compact.includes('qwen3coder')
  )
}

function atomicQ8Draft(
  repo: string,
  draftFilename: string
): Pick<DflashDraft, 'quant' | 'repo' | 'draftFilename'> {
  return {
    quant: 'Q8_0',
    repo,
    draftFilename,
  }
}

const REGISTRY: readonly DflashRegistryEntry[] = [
  {
    matches: (id) => compactId(id).includes('qwen3codernext'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3-Coder-Next-DFlash-GGUF',
        'Qwen3-Coder-Next-DFlash.Q8_0.gguf'
      ),
    ],
  },
  {
    matches: (id) => {
      const compact = compactId(id)
      return (
        compact.includes('qwen3coder') &&
        compact.includes('30b') &&
        compact.includes('a3b')
      )
    },
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3-Coder-30B-A3B-DFlash-GGUF',
        'Qwen3-Coder-30B-A3B-DFlash.Q8_0.gguf'
      ),
    ],
  },
  {
    matches: (id) => compactId(id).includes('qwen3527b'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3.5-27B-DFlash-GGUF',
        'Qwen3.5-27B-DFlash.Q8_0.gguf'
      ),
    ],
  },
  {
    matches: (id) => compactId(id).includes('qwen354b'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3.5-4B-DFlash-GGUF',
        'Qwen3.5-4B-DFlash.Q8_0.gguf'
      ),
    ],
  },
  {
    matches: (id) =>
      isBaseQwen3(id) && compactId(id).includes('qwen38b'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3-8B-DFlash-GGUF',
        'Qwen3-8B-DFlash.Q8_0.gguf'
      ),
    ],
  },
  {
    matches: (id) =>
      isBaseQwen3(id) && compactId(id).includes('qwen34b'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3-4B-DFlash-GGUF',
        'Qwen3-4B-DFlash.Q8_0.gguf'
      ),
    ],
  },
  {
    // Qwen3.5-9B (dense). e.g. Qwen3.5-9B-Instruct-Q4_K_M, qwen3.5-9b-...
    matches: (id) => hasQwenFamily(id, '35') && id.includes('9b'),
    drafts: [
      {
        quant: 'Q4_K_M',
        repo: 'onion515/Qwen3.5-9B-DFlash-GGUF',
        draftFilename: 'qwen3.5-9b-dflash-Q4_K_M.gguf',
      },
      {
        quant: 'Q5_K_M',
        repo: 'onion515/Qwen3.5-9B-DFlash-GGUF',
        draftFilename: 'qwen3.5-9b-dflash-Q5_K_M.gguf',
      },
      {
        quant: 'Q6_K',
        repo: 'onion515/Qwen3.5-9B-DFlash-GGUF',
        draftFilename: 'qwen3.5-9b-dflash-Q6_K.gguf',
      },
      {
        quant: 'Q8_0',
        repo: 'AtomicChat/Qwen3.5-9B-DFlash-GGUF',
        draftFilename: 'Qwen3.5-9B-DFlash.Q8_0.gguf',
      },
      {
        quant: 'BF16',
        repo: 'onion515/Qwen3.5-9B-DFlash-GGUF',
        draftFilename: 'qwen3.5-9b-dflash-bf16.gguf',
      },
    ],
  },
  {
    // Qwen3.6-35B-A3B (MoE). Require "35b" + "a3b" so only the MoE matches;
    // checked before the 27B entry (both are 3.6 but the size tokens disjoin).
    matches: (id) =>
      hasQwenFamily(id, '36') && id.includes('35b') && id.includes('a3b'),
    drafts: [
      {
        quant: 'IQ4_XS',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-IQ4_XS.gguf',
      },
      {
        quant: 'Q4_K_M',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-Q4_K_M.gguf',
      },
      {
        quant: 'Q5_K_M',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-Q5_K_M.gguf',
      },
      {
        quant: 'Q6_K',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-Q6_K.gguf',
      },
      {
        quant: 'Q8_0',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-Q8_0.gguf',
      },
      {
        quant: 'F16',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-F16.gguf',
      },
    ],
  },
  {
    // Qwen3.6-27B (dense).
    matches: (id) => hasQwenFamily(id, '36') && id.includes('27b'),
    drafts: [
      {
        quant: 'IQ4_XS',
        repo: 'williamliao/qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash-IQ4_XS.gguf',
      },
      {
        quant: 'Q4_K_M',
        repo: 'williamliao/qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash-Q4_K_M.gguf',
      },
      {
        quant: 'Q5_K_M',
        repo: 'williamliao/qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash-Q5_K_M.gguf',
      },
      {
        quant: 'Q6_K',
        repo: 'williamliao/qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash-Q6_K.gguf',
      },
      {
        quant: 'Q8_0',
        repo: 'AtomicChat/Qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash.Q8_0.gguf',
      },
      {
        quant: 'F16',
        repo: 'williamliao/qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash-F16.gguf',
      },
    ],
  },
]

/**
 * Every draft this registry downloads — the files the app itself puts on disk
 * next to a target. The web app's model-file filter is tested against them so
 * a local scan never offers one back as a model (ATO-523).
 */
export const DFLASH_DRAFT_FILENAMES: readonly string[] = REGISTRY.flatMap(
  (entry) => entry.drafts.map((draft) => draft.draftFilename)
)

export const DEFAULT_DFLASH_DRAFT_QUANT = 'Q8_0'

function normalizeId(modelId: string): string {
  return modelId.toLowerCase()
}

/**
 * Resolve the DFlash draft for a target model id, or `null` if the model is
 * not a DFlash-capable target in the registry.
 */
export function listDflashDrafts(modelId: string): DflashDraft[] {
  const normalized = normalizeId(modelId)
  const entry = REGISTRY.find((e) => e.matches(normalized))
  return entry?.drafts.map((draft) => ({ ...draft, ...atomicAuxiliaryFile(draft.repo, draft.draftFilename) })) ?? []
}

export function resolveDflashDraft(
  modelId: string,
  quant = DEFAULT_DFLASH_DRAFT_QUANT
): DflashDraft | null {
  const drafts = listDflashDrafts(modelId)
  const exact = drafts.find((draft) => draft.quant === quant)
  if (exact) return exact
  return quant === DEFAULT_DFLASH_DRAFT_QUANT ? drafts[0] ?? null : null
}

/** Whether the given model id is a DFlash-capable target. */
export function checkDflashSupport(modelId: string): boolean {
  return listDflashDrafts(modelId).length > 0
}

/** Build the Hugging Face resolve URL for a DFlash draft. */
export function dflashDraftUrl(draft: DflashDraft): string {
  return `https://huggingface.co/${draft.repo}/resolve/${draft.revision}/${draft.draftFilename}`
}
