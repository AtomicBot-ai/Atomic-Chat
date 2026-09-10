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
  draftSha256: string
  /** Pinned byte size of the draft file for download validation. */
  draftSize: number
}

interface DflashRegistryEntry {
  /**
   * Predicate over a normalized (lowercased) model id that decides whether the
   * id refers to this target family. Kept deliberately strict so unrelated
   * Qwen sizes never resolve a draft.
   */
  matches: (normalizedId: string) => boolean
  drafts: readonly DflashDraft[]
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
  draftFilename: string,
  draftSha256: string,
  draftSize: number
): DflashDraft {
  return {
    quant: 'Q8_0',
    repo,
    draftFilename,
    draftSha256,
    draftSize,
  }
}

const REGISTRY: readonly DflashRegistryEntry[] = [
  {
    matches: (id) => compactId(id).includes('qwen3codernext'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3-Coder-Next-DFlash-GGUF',
        'Qwen3-Coder-Next-DFlash.Q8_0.gguf',
        '139081af2f9f634b3b8bce8f75a0449f92bcb75ae7a2e32abaf1bcdf6f4a7952',
        509674720
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
        'Qwen3-Coder-30B-A3B-DFlash.Q8_0.gguf',
        'abd0e078f1e5683ba83c4ced92836b136d9e2e6b2626715b699088fd5c3a51fc',
        509674848
      ),
    ],
  },
  {
    matches: (id) => compactId(id).includes('qwen3527b'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3.5-27B-DFlash-GGUF',
        'Qwen3.5-27B-DFlash.Q8_0.gguf',
        'e24126896291f03a8dd6da7da8678ea4d7b019d6fc3719ecf6136e392f361645',
        2272886944
      ),
    ],
  },
  {
    matches: (id) => compactId(id).includes('qwen354b'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3.5-4B-DFlash-GGUF',
        'Qwen3.5-4B-DFlash.Q8_0.gguf',
        'f0689eadab0d46468bc2629bb2706f4aba7f794b63e1c9f6eb291269d572a52b',
        685133984
      ),
    ],
  },
  {
    matches: (id) =>
      isBaseQwen3(id) && compactId(id).includes('qwen38b'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3-8B-DFlash-GGUF',
        'Qwen3-8B-DFlash.Q8_0.gguf',
        '5be4f6b1bfd5c2c1aa753d4c03e30700114654fefbbf29f02257ef37adb00bf0',
        1120250336
      ),
    ],
  },
  {
    matches: (id) =>
      isBaseQwen3(id) && compactId(id).includes('qwen34b'),
    drafts: [
      atomicQ8Draft(
        'AtomicChat/Qwen3-4B-DFlash-GGUF',
        'Qwen3-4B-DFlash.Q8_0.gguf',
        '2913a8a5619b30233c0745ccd58de8fbe144b831b54770eb04d4a371221ca273',
        577047008
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
        draftSha256:
          'd9999163059b9ae0e87b0f503d76451d922b5483c981d9afae250d82804b5f0d',
        draftSize: 765960384,
      },
      {
        quant: 'Q5_K_M',
        repo: 'onion515/Qwen3.5-9B-DFlash-GGUF',
        draftFilename: 'qwen3.5-9b-dflash-Q5_K_M.gguf',
        draftSha256:
          'aa7521c7c210d1fd56e4e7520b6cbb5df6d0c7f813c8ddddff0861c4f8663045',
        draftSize: 913809600,
      },
      {
        quant: 'Q6_K',
        repo: 'onion515/Qwen3.5-9B-DFlash-GGUF',
        draftFilename: 'qwen3.5-9b-dflash-Q6_K.gguf',
        draftSha256:
          '4c9a1e123944e008ebc55677ba9d51a63dc81fcdb80e44a9a3e405e57563f8b0',
        draftSize: 1070899392,
      },
      {
        quant: 'Q8_0',
        repo: 'AtomicChat/Qwen3.5-9B-DFlash-GGUF',
        draftFilename: 'Qwen3.5-9B-DFlash.Q8_0.gguf',
        draftSha256:
          '27b9d18e605aea9c50ef506e4b63921e0dc624cc91c63c60617a8295f153d436',
        draftSize: 1383768224,
      },
      {
        quant: 'BF16',
        repo: 'onion515/Qwen3.5-9B-DFlash-GGUF',
        draftFilename: 'qwen3.5-9b-dflash-bf16.gguf',
        draftSha256:
          '9c1f55bc887fc5efb565748580a6526a5c1ef9bdd1893002ccdca7be4d1213a5',
        draftSize: 2594873536,
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
        draftSha256:
          '13866fb2301f34cc31b5b8cda9ee1059bb7468ba5ef636be7e5e98d6fd371cdc',
        draftSize: 218030368,
      },
      {
        quant: 'Q4_K_M',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-Q4_K_M.gguf',
        draftSha256:
          '9f8a75a850d9e207ca8a8de2cfa691aef61c63895d224defc00abfc34d5779bd',
        draftSize: 235692320,
      },
      {
        quant: 'Q5_K_M',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-Q5_K_M.gguf',
        draftSha256:
          '397df52ae2bb4afd88c1272a122001dc56ad2546153038aee468f6371b0045e9',
        draftSize: 280256800,
      },
      {
        quant: 'Q6_K',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-Q6_K.gguf',
        draftSha256:
          'c1fe996a6f198c867b3d422b9bcf5c385f1dcc29b877628ccb2af1f9e278f649',
        draftSize: 327606560,
      },
      {
        quant: 'Q8_0',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-Q8_0.gguf',
        draftSha256:
          'fc79ee2c84688674e4f134d5797a6baee4884167659a6eec8866c7789ee1318b',
        draftSize: 421060896,
      },
      {
        quant: 'F16',
        repo: 'williamliao/Qwen3.6-35B-A3B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-35B-A3B-DFlash-F16.gguf',
        draftSha256:
          'bd5385344d049ae9770972b9b694dfcc18005d7f4b9dfabde04f9b30ce21b631',
        draftSize: 782819616,
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
        draftSha256:
          '23861020ce5313567cb8e8fe56ce01b5f8e467df7d23ebecfe17fd19136f97d7',
        draftSize: 934435136,
      },
      {
        quant: 'Q4_K_M',
        repo: 'williamliao/qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash-Q4_K_M.gguf',
        draftSha256:
          '47901c650191c72a73a3d69e1f7cfa5744bce2bb46f82e6ebeaf729f90f5c3a3',
        draftSize: 1033066816,
      },
      {
        quant: 'Q5_K_M',
        repo: 'williamliao/qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash-Q5_K_M.gguf',
        draftSha256:
          'ece22ee82e7a9acbd7b9617b4b252b029e3f3cd8a7a6a398362ebdd5b56b520f',
        draftSize: 1225742656,
      },
      {
        quant: 'Q6_K',
        repo: 'williamliao/qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash-Q6_K.gguf',
        draftSha256:
          'ff4197923ce8d9c56f2dc745cfa95a1820d8d63a51aab66d4ad88d0827b6d8a4',
        draftSize: 1430460736,
      },
      {
        quant: 'Q8_0',
        repo: 'AtomicChat/Qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash.Q8_0.gguf',
        draftSha256:
          'b9be52167d0b4f5cbaffba6658bcb20dd814ad4e5846532353c165ccf97e47a1',
        draftSize: 1849481472,
      },
      {
        quant: 'F16',
        repo: 'williamliao/qwen3.6-27B-DFlash-GGUF',
        draftFilename: 'Qwen3.6-27B-DFlash-F16.gguf',
        draftSha256:
          '6bbbca1f2391ee5adf76e01ee9b7614787dbf0cecc5b67b45f5a20003915c081',
        draftSize: 3471497536,
      },
    ],
  },
]

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
  return entry?.drafts.map((draft) => ({ ...draft })) ?? []
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
  return `https://huggingface.co/${draft.repo}/resolve/main/${draft.draftFilename}`
}
