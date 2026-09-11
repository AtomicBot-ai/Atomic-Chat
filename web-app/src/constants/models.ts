/**
 * Model-related constants
 */

import type { CatalogModel } from '@/services/models/types'
import type { Recommendation } from '@/services/recommended-models-registry'
import type { HardwareTier } from '@/lib/hardware-tier'

export const EMBEDDING_MODEL_ID = 'sentence-transformer-mini'

/**
 * One rung of the recommendation ladder: the single model onboarding offers to
 * a machine on that tier, and what the "why this one" line needs to say before
 * the catalog entry has resolved.
 */
export type LadderEntry = {
  /** Hugging Face repo id. */
  repo: string
  /** Display name — this line is not translated, matching its siblings. */
  title: string
  /** Quant pin; see `findPinnedQuant`. Every rung pins one deliberately. */
  quant: string
  /** Vision models only: projector pin. */
  mmprojQuant?: string
  /** Total download (weights + projector) in GiB, for the pre-resolve line. */
  sizeGb: number
  /** Hub category label, shared with the manifest's `description_key`. */
  descriptionKey: string
}

// The three rungs from 16 GiB up, each shared by several tiers below.
const GEMMA_4_12B_QAT: LadderEntry = {
  repo: 'unsloth/gemma-4-12B-it-qat-GGUF',
  title: 'Gemma 4 12B (QAT)',
  quant: 'Q4_K_XL',
  mmprojQuant: 'F16',
  sizeGb: 6.42,
  descriptionKey: 'hub:recVisionKnowledge',
}

const QWEN_3_6_27B: LadderEntry = {
  repo: 'AtomicChat/Qwen3.6-27B-GGUF',
  title: 'Qwen3.6 27B',
  quant: 'Q4_K_M',
  sizeGb: 15.41,
  descriptionKey: 'hub:recCoding',
}

const QWEN_3_6_35B_A3B: LadderEntry = {
  repo: 'AtomicChat/Qwen3.6-35B-A3B-GGUF',
  title: 'Qwen3.6 35B A3B',
  quant: 'Q4_K_M',
  sizeGb: 19.71,
  descriptionKey: 'hub:recMathReasoning',
}

/**
 * What we recommend, per hardware tier (ATO-463).
 *
 * Up to 12 GiB the principle, set by product, is **optimize the speed of the
 * first decent answer, not the largest model that fits.** From 16 GiB up the
 * offer scales with memory instead (product decision, 2026-09-11), the same on
 * a card and on unified memory: Gemma 4 12B at 16, Qwen3.6 27B at 24, and
 * Qwen3.6 35B A3B from 32 up — sparse, 3B active per token, so it answers at a
 * small model's per-token cost despite the larger download.
 *
 * An 18 GB Mac lands on `unified_24`, where the 27B (15.4 GiB) is past the
 * Metal ceiling; `useResolvedRecommendedModels` steps it down to the 16 GiB
 * rung once the card's size is known.
 *
 * Three measurements decided the lower rungs:
 *
 *  - **27B is slow for its size.** It is the most-used model in the whole
 *    dataset (105 devices) and sits on the edge of unusable: 15.1 tok/s median,
 *    5.4 at the lower quartile, after a 15 GB download. It is kept off every
 *    rung below 24 GiB.
 *  - **`gemma-4-E2B-it` is out.** Its name is MatFormer effective parameters,
 *    not file size: it weighs 3.19 GB, more than `Qwen3.5-4B` at 2.52, which is
 *    both measured faster and smaller. It was in the `standard` tier as the
 *    "light" option, which was simply wrong.
 *  - **12B enters at the top as the QAT build.** `unsloth/gemma-4-12B-it-qat`
 *    UD-Q4_K_XL is 6.26 GiB — the same as a plain Q4_0 and lighter than Q4_K_M
 *    — but quantization-aware training keeps four-bit quality close to the
 *    unquantized model. Measured at 37.8 tok/s median. A free upgrade.
 *
 * Everything is `Q4_K_M` (or the QAT repo's single UD-Q4_K_XL) rather than
 * `IQ4_XS`, which is ~0.5 GiB lighter: i-quants need more compute per weight
 * and are markedly slower on CPU and on some Vulkan backends, and a large part
 * of the base is exactly there (ATO-464).
 *
 * `AtomicChat/*` mirrors are preferred wherever they carry the quant we want —
 * third-party mirrors fail downloads more often (ATO-467). Only the 12B QAT has
 * no mirror of ours.
 *
 * Composition can be overridden without a release through the manifest's
 * `tiers` key; the tier vocabulary itself is a release-time contract.
 */
export const RECOMMENDATION_LADDER: Readonly<
  Record<HardwareTier, LadderEntry>
> = {
  // Under 2.5 GiB of VRAM is 741 Windows devices — integrated graphics and
  // pre-Turing cards. Even LFM2.5-2.6B (1.56 GiB) plus its KV cache is tight
  // there, so this rung goes a size lower.
  vram_2: {
    repo: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
    title: 'LFM2.5 1.2B Instruct',
    quant: 'Q4_K_M',
    sizeGb: 0.68,
    descriptionKey: 'hub:recEverydayUse',
  },
  // No accelerator at all: throughput is bound by the CPU, and more system
  // RAM does not buy any of it back. The lightest rung, whatever the RAM.
  cpu_only: {
    repo: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
    title: 'LFM2.5 1.2B Instruct',
    quant: 'Q4_K_M',
    sizeGb: 0.68,
    descriptionKey: 'hub:recEverydayUse',
  },
  vram_4: {
    repo: 'LiquidAI/LFM2.5-2.6B-GGUF',
    title: 'LFM2.5 2.6B',
    quant: 'Q4_K_M',
    sizeGb: 1.56,
    descriptionKey: 'hub:recEverydayUse',
  },
  // 5–9 GiB of VRAM is the most populated bucket in the base (~2750 devices).
  vram_8: {
    repo: 'AtomicChat/Qwen3.5-4B-GGUF',
    title: 'Qwen3.5 4B',
    quant: 'Q4_K_M',
    sizeGb: 2.52,
    descriptionKey: 'hub:recEverydayUse',
  },
  // Fastest model in our own measurement: 87 tok/s median, 0.89 s to first
  // token. Vision-capable, hence the projector pin.
  vram_12: {
    repo: 'AtomicChat/gemma-4-E4B-it-GGUF',
    title: 'Gemma 4 E4B',
    quant: 'Q4_K_M',
    mmprojQuant: 'F16',
    sizeGb: 5.89,
    descriptionKey: 'hub:recVisionKnowledge',
  },
  vram_16: GEMMA_4_12B_QAT,
  vram_24: QWEN_3_6_27B,
  vram_32: QWEN_3_6_35B_A3B,
  vram_48: QWEN_3_6_35B_A3B,
  vram_64: QWEN_3_6_35B_A3B,
  vram_64_plus: QWEN_3_6_35B_A3B,
  // Below 16 GiB a Mac gets a rung lighter than a PC with the same number on
  // it: the Metal ceiling is hard, and unified memory is shared with
  // everything else the machine is doing, whereas VRAM on a card is the
  // model's alone.
  unified_8: {
    repo: 'LiquidAI/LFM2.5-2.6B-GGUF',
    title: 'LFM2.5 2.6B',
    quant: 'Q4_K_M',
    sizeGb: 1.56,
    descriptionKey: 'hub:recEverydayUse',
  },
  unified_16: GEMMA_4_12B_QAT,
  unified_24: QWEN_3_6_27B,
  unified_32: QWEN_3_6_35B_A3B,
  unified_48: QWEN_3_6_35B_A3B,
  unified_64: QWEN_3_6_35B_A3B,
  unified_64_plus: QWEN_3_6_35B_A3B,
}

/**
 * The tier a machine gets when hardware never resolved.
 *
 * Conservative on purpose: `PICKER_INPUT_DEADLINE_MS` gives enumeration four
 * seconds, and whatever has not answered by then still needs a default. An
 * over-light recommendation downloads fast and runs; an over-heavy one on an
 * unknown machine is the exact failure this ladder exists to remove.
 */
export const FALLBACK_HARDWARE_TIER: HardwareTier = 'vram_8'

const ladderToRecommendation = (entry: LadderEntry): Recommendation => ({
  model_name: entry.repo,
  description_key: entry.descriptionKey,
  quant: entry.quant,
  ...(entry.mmprojQuant ? { mmproj_quant: entry.mmprojQuant } : {}),
})

/**
 * Bundled per-tier fallback for the recommended-models registry, mirroring the
 * manifest's `tiers` key so the picker can paint on the very first launch and
 * when the network is unavailable.
 *
 * Derived from {@link RECOMMENDATION_LADDER} rather than written out again, so
 * the offer and the reminder below cannot drift apart.
 */
export const BASELINE_TIER_RECOMMENDATIONS: Readonly<
  Record<HardwareTier, Recommendation[]>
> = Object.fromEntries(
  Object.entries(RECOMMENDATION_LADDER).map(([tier, entry]) => [
    tier,
    [ladderToRecommendation(entry)],
  ])
) as Record<HardwareTier, Recommendation[]>

/** What the bottom-right reminder offers, keyed by hardware tier. */
export type OnboardingReminderModel = {
  /** Hugging Face repo id. */
  repo: string
  /** Display name — this card is not translated, matching its siblings. */
  title: string
  /** Quant pin; see `findPinnedQuant`. Omitted = house default. */
  quant?: string
  /** Vision models only: projector pin. */
  mmprojQuant?: string
}

/**
 * The reminder and the composer's "what do I reply with?" widget must offer the
 * same model the first screen did — a second opinion that drifts from it is
 * worse than no second surface. Both read this, and it is the ladder.
 */
export const ONBOARDING_REMINDER_MODELS: Record<
  HardwareTier,
  OnboardingReminderModel
> = Object.fromEntries(
  Object.entries(RECOMMENDATION_LADDER).map(([tier, entry]) => [
    tier,
    {
      repo: entry.repo,
      title: entry.title,
      quant: entry.quant,
      ...(entry.mmprojQuant ? { mmprojQuant: entry.mmprojQuant } : {}),
    },
  ])
) as Record<HardwareTier, OnboardingReminderModel>

/**
 * Repo the reminder falls back to when the tier is unknown. Kept as a named
 * export because other call sites reference the "house default" repo directly.
 */
export const ONBOARDING_REMINDER_MODEL_HF_REPO =
  RECOMMENDATION_LADDER[FALLBACK_HARDWARE_TIER].repo

export const JAN_CODE_HF_REPO = 'janhq/Jan-Code-4b-Gguf'
export const DEFAULT_MODEL_QUANTIZATIONS = ['iq4_xs', 'q4_k_m']

/**
 * Quantizations to check for SetupScreen quick start
 * Includes Q8 for higher quality on capable systems
 */
export const SETUP_SCREEN_QUANTIZATIONS = ['q4_k_m']

/**
 * Bundled fallback for the manifest's flat `recommendations` list.
 *
 * Since ATO-463 this list is no longer what the first screen leads with — that
 * is {@link RECOMMENDATION_LADDER}, chosen by hardware. It is the pool behind
 * "other options", and it is what a client too old to know about `tiers` still
 * shows, so it stays a curated, generally-runnable set.
 *
 * Platform filtering happens at runtime in
 * `recommended-models-registry-store.ts` — keep `platforms` declarative here
 * (do NOT inline `IS_MACOS` ternaries) so the baseline mirrors the manifest
 * shape verbatim.
 */
export const BASELINE_RECOMMENDED_MODELS: ReadonlyArray<Recommendation> = [
  {
    model_name: 'AtomicChat/Qwen3.5-4B-GGUF',
    description_key: 'hub:recEverydayUse',
    quant: 'Q4_K_M',
  },
  {
    model_name: 'AtomicChat/Qwen3.5-9B-GGUF',
    description_key: 'hub:recEverydayUse',
    quant: 'Q4_K_M',
  },
  {
    model_name: 'AtomicChat/gemma-4-E4B-it-GGUF',
    description_key: 'hub:recVisionKnowledge',
    quant: 'Q4_K_M',
    mmproj_quant: 'F16',
  },
]

const ATOMIC_GEMMA4_E4B_HF =
  'https://huggingface.co/AtomicChat/gemma-4-E4B-it-GGUF/resolve/main'
const ATOMIC_QWEN35_4B_HF =
  'https://huggingface.co/AtomicChat/Qwen3.5-4B-GGUF/resolve/main'
const ATOMIC_QWEN35_9B_HF =
  'https://huggingface.co/AtomicChat/Qwen3.5-9B-GGUF/resolve/main'
const ATOMIC_QWEN3_CODER_HF =
  'https://huggingface.co/AtomicChat/qwen3-coder-30b-a3b-GGUF/resolve/main'
const LFM_1_2B_HF =
  'https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main'
const LFM_2_6B_HF =
  'https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF/resolve/main'
const GEMMA4_12B_QAT_HF =
  'https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/main'
const QWEN_MLX_HF =
  'https://huggingface.co/mlx-community/Qwen3.5-9B-MLX-4bit/resolve/main'

//! MLX-fallback инжектится только на macOS — иначе утекает через useState-инициализацию
//! useResolvedRecommendedModels и через прямое чтение в routes/hub/$modelId.tsx
const MLX_QWEN_FALLBACK: CatalogModel = {
  model_name: 'mlx-community/Qwen3.5-9B-MLX-4bit',
  developer: 'mlx-community',
  library_name: 'mlx',
  description:
    '**Tags**: Image-Text-to-Text, MLX, Safetensors, qwen3_5, vision-language-model, 4-bit, conversational',
  downloads: 73490,
  num_safetensors: 1,
  safetensors_files: [
    {
      model_id: 'mlx-community/Qwen3.5-9B-MLX-4bit',
      path: `${QWEN_MLX_HF}/model.safetensors`,
      file_size: '5.6 GB',
    },
  ],
  is_mlx: true,
  readme: `${QWEN_MLX_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
}

/**
 * Catalog cards for the repos onboarding can offer, so the first screen paints
 * a real model with a real size before any network call resolves — and still
 * paints one if none ever does.
 *
 * Every rung of {@link RECOMMENDATION_LADDER} has an entry here. Sizes are the
 * actual LFS sizes read from Hugging Face (2026-09-08), in GiB, which is what
 * `parseFileSizeToBytes` assumes a "GB" suffix means.
 *
 * Only the quant each rung pins is listed for the single-quant entries; the
 * full ladder is kept for `gemma-4-E4B-it` because the Hub model page reads
 * this map too and that card is the one users open.
 */
export const RECOMMENDED_MODEL_FALLBACKS: Readonly<
  Record<string, CatalogModel>
> = {
  'AtomicChat/gemma-4-E4B-it-GGUF': {
    model_name: 'AtomicChat/gemma-4-E4B-it-GGUF',
    developer: 'AtomicChat',
    description:
      '**Tags**: Image-Text-to-Text, GGUF, gemma4, atomic-chat, google, imatrix, conversational',
    downloads: 0,
    num_quants: 12,
    quants: [
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q8_0',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q8_0.gguf`,
        file_size: '8.0 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q6_K',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q6_K.gguf`,
        file_size: '7.0 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q5_K_M',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q5_K_M.gguf`,
        file_size: '5.5 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q5_K_S',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q5_K_S.gguf`,
        file_size: '5.4 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-UD-Q4_K_XL',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-UD-Q4_K_XL.gguf`,
        file_size: '5.76 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q4_K_M',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q4_K_M.gguf`,
        file_size: '4.97 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q4_K_S',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q4_K_S.gguf`,
        file_size: '4.7 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-IQ4_XS',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-IQ4_XS.gguf`,
        file_size: '4.5 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q3_K_L',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q3_K_L.gguf`,
        file_size: '4.4 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q3_K_M',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q3_K_M.gguf`,
        file_size: '4.1 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-IQ3_M',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-IQ3_M.gguf`,
        file_size: '3.8 GB',
      },
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q2_K',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q2_K.gguf`,
        file_size: '3.3 GB',
      },
    ],
    num_mmproj: 1,
    mmproj_models: [
      {
        //! Не переименован вместе с весами — имя файла в репозитории именно такое.
        model_id: 'mmproj-gemma4-e4b-it-f16',
        path: `${ATOMIC_GEMMA4_E4B_HF}/mmproj-gemma4-e4b-it-f16.gguf`,
        file_size: '0.92 GB',
      },
    ],
    readme: `${ATOMIC_GEMMA4_E4B_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  'AtomicChat/Qwen3.5-4B-GGUF': {
    model_name: 'AtomicChat/Qwen3.5-4B-GGUF',
    developer: 'AtomicChat',
    description:
      '**Tags**: text-generation, GGUF, qwen3, atomic-chat, imatrix, conversational',
    downloads: 0,
    num_quants: 1,
    quants: [
      {
        model_id: 'AtomicChat/qwen35-4b-Q4_K_M',
        path: `${ATOMIC_QWEN35_4B_HF}/qwen35-4b-Q4_K_M.gguf`,
        file_size: '2.52 GB',
      },
    ],
    num_mmproj: 0,
    mmproj_models: [],
    readme: `${ATOMIC_QWEN35_4B_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  'AtomicChat/Qwen3.5-9B-GGUF': {
    model_name: 'AtomicChat/Qwen3.5-9B-GGUF',
    developer: 'AtomicChat',
    description:
      '**Tags**: text-generation, GGUF, qwen3, atomic-chat, imatrix, conversational',
    downloads: 0,
    num_quants: 1,
    quants: [
      {
        model_id: 'AtomicChat/qwen35-9b-Q4_K_M',
        path: `${ATOMIC_QWEN35_9B_HF}/qwen35-9b-Q4_K_M.gguf`,
        file_size: '5.24 GB',
      },
    ],
    num_mmproj: 0,
    mmproj_models: [],
    readme: `${ATOMIC_QWEN35_9B_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  'LiquidAI/LFM2.5-1.2B-Instruct-GGUF': {
    model_name: 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
    developer: 'LiquidAI',
    description:
      '**Tags**: text-generation, GGUF, lfm2, liquidai, conversational',
    downloads: 0,
    num_quants: 1,
    quants: [
      {
        model_id: 'LiquidAI/LFM2.5-1.2B-Instruct-Q4_K_M',
        path: `${LFM_1_2B_HF}/LFM2.5-1.2B-Instruct-Q4_K_M.gguf`,
        file_size: '0.68 GB',
      },
    ],
    num_mmproj: 0,
    mmproj_models: [],
    readme: `${LFM_1_2B_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  'LiquidAI/LFM2.5-2.6B-GGUF': {
    model_name: 'LiquidAI/LFM2.5-2.6B-GGUF',
    developer: 'LiquidAI',
    description:
      '**Tags**: text-generation, GGUF, lfm2, liquidai, conversational',
    downloads: 0,
    num_quants: 1,
    quants: [
      {
        model_id: 'LiquidAI/LFM2.5-2.6B-Q4_K_M',
        path: `${LFM_2_6B_HF}/LFM2.5-2.6B-Q4_K_M.gguf`,
        file_size: '1.56 GB',
      },
    ],
    num_mmproj: 0,
    mmproj_models: [],
    readme: `${LFM_2_6B_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  'unsloth/gemma-4-12B-it-qat-GGUF': {
    model_name: 'unsloth/gemma-4-12B-it-qat-GGUF',
    developer: 'unsloth',
    description:
      '**Tags**: Image-Text-to-Text, GGUF, gemma4, unsloth, qat, conversational',
    downloads: 0,
    num_quants: 1,
    quants: [
      {
        //! Единственный квант в QAT-репозитории — лестницы там нет, берём что есть.
        model_id: 'unsloth/gemma-4-12B-it-qat-UD-Q4_K_XL',
        path: `${GEMMA4_12B_QAT_HF}/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf`,
        file_size: '6.26 GB',
      },
    ],
    num_mmproj: 1,
    mmproj_models: [
      {
        model_id: 'mmproj-F16',
        path: `${GEMMA4_12B_QAT_HF}/mmproj-F16.gguf`,
        file_size: '0.16 GB',
      },
    ],
    readme: `${GEMMA4_12B_QAT_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  'AtomicChat/qwen3-coder-30b-a3b-GGUF': {
    model_name: 'AtomicChat/qwen3-coder-30b-a3b-GGUF',
    developer: 'AtomicChat',
    description:
      '**Tags**: text-generation, GGUF, qwen3, qwen3-coder, atomic-chat, imatrix, conversational',
    downloads: 0,
    num_quants: 0,
    quants: [],
    num_mmproj: 0,
    mmproj_models: [],
    readme: `${ATOMIC_QWEN3_CODER_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  ...(IS_MACOS
    ? { 'mlx-community/Qwen3.5-9B-MLX-4bit': MLX_QWEN_FALLBACK }
    : {}),
}

/**
 * Bundled offline-first fallback for the model catalog registry.
 *
 * Lives next to `RECOMMENDED_MODEL_FALLBACKS` above but serves a different
 * purpose: this list seeds `useModelCatalogStore` when neither the
 * `localStorage` cache nor the network fetch succeed (e.g. first launch on
 * an air-gapped machine). Each entry follows the exact `CatalogModel` shape
 * so the existing download pipeline can act on it without conversion.
 *
 * Keep it small (~10 entries) — the goal is for Hub to render something
 * useful before the real catalog lands, not to mirror the full curated set.
 */
export const BASELINE_MODEL_CATALOG: ReadonlyArray<CatalogModel> = [
  {
    model_name: 'AtomicChat/gemma-4-E4B-it-GGUF',
    developer: 'AtomicChat',
    description:
      '**Tags**: gguf, gemma4, atomic-chat, google, imatrix, conversational, image-text-to-text',
    downloads: 0,
    num_quants: 1,
    quants: [
      {
        model_id: 'AtomicChat/gemma-4-E4B-it-Q4_K_M',
        path: `${ATOMIC_GEMMA4_E4B_HF}/gemma-4-E4B-it-Q4_K_M.gguf`,
        file_size: '4.97 GB',
      },
    ],
    num_mmproj: 1,
    mmproj_models: [
      {
        model_id: 'mmproj-gemma4-e4b-it-f16',
        path: `${ATOMIC_GEMMA4_E4B_HF}/mmproj-gemma4-e4b-it-f16.gguf`,
        file_size: '0.92 GB',
      },
    ],
    num_safetensors: 0,
    safetensors_files: [],
    is_mlx: false,
    readme: `${ATOMIC_GEMMA4_E4B_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  {
    model_name: 'AtomicChat/Qwen3.5-4B-GGUF',
    developer: 'AtomicChat',
    description: '**Tags**: gguf, qwen3, atomic-chat, imatrix, conversational',
    downloads: 0,
    num_quants: 0,
    quants: [],
    num_mmproj: 0,
    mmproj_models: [],
    num_safetensors: 0,
    safetensors_files: [],
    is_mlx: false,
    readme: `${ATOMIC_QWEN35_4B_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  {
    model_name: 'AtomicChat/qwen36-27b-GGUF',
    developer: 'AtomicChat',
    description: '**Tags**: gguf, qwen3, atomic-chat, imatrix, conversational',
    downloads: 0,
    num_quants: 0,
    quants: [],
    num_mmproj: 0,
    mmproj_models: [],
    num_safetensors: 0,
    safetensors_files: [],
    is_mlx: false,
    readme:
      'https://huggingface.co/AtomicChat/qwen36-27b-GGUF/resolve/main/README.md',
  },
  {
    model_name: 'AtomicChat/qwen3-coder-30b-a3b-GGUF',
    developer: 'AtomicChat',
    description:
      '**Tags**: gguf, qwen3, qwen3-coder, atomic-chat, imatrix, conversational',
    downloads: 0,
    num_quants: 0,
    quants: [],
    num_mmproj: 0,
    mmproj_models: [],
    num_safetensors: 0,
    safetensors_files: [],
    is_mlx: false,
    readme: `${ATOMIC_QWEN3_CODER_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  {
    model_name: 'unsloth/Llama-3.2-3B-Instruct-GGUF',
    developer: 'unsloth',
    description: '**Tags**: gguf, llama, unsloth, conversational',
    downloads: 0,
    num_quants: 0,
    quants: [],
    num_mmproj: 0,
    mmproj_models: [],
    num_safetensors: 0,
    safetensors_files: [],
    is_mlx: false,
    readme:
      'https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/README.md',
  },
  {
    model_name: 'mlx-community/Qwen3.5-9B-MLX-4bit',
    developer: 'mlx-community',
    library_name: 'mlx',
    description:
      '**Tags**: mlx, qwen3_5, vision-language-model, 4-bit, conversational',
    downloads: 73490,
    num_quants: 0,
    quants: [],
    num_mmproj: 0,
    mmproj_models: [],
    num_safetensors: 1,
    safetensors_files: [
      {
        model_id: 'mlx-community/Qwen3.5-9B-MLX-4bit',
        path: `${QWEN_MLX_HF}/model.safetensors`,
        file_size: '5.6 GB',
      },
    ],
    is_mlx: true,
    readme: `${QWEN_MLX_HF.replace('/resolve/main', '')}/resolve/main/README.md`,
  },
  {
    model_name: 'mlx-community/gemma-4-e4b-it-4bit',
    developer: 'mlx-community',
    library_name: 'mlx',
    description: '**Tags**: mlx, gemma4, 4-bit, conversational',
    downloads: 0,
    num_quants: 0,
    quants: [],
    num_mmproj: 0,
    mmproj_models: [],
    num_safetensors: 0,
    safetensors_files: [],
    is_mlx: true,
    readme:
      'https://huggingface.co/mlx-community/gemma-4-e4b-it-4bit/resolve/main/README.md',
  },
]

export const JAN_V2_VL_MODEL_HF_REPO = 'janhq/Jan-v2-VL-high-gguf'
export const JAN_V2_VL_QUANTIZATIONS = ['q4_k_m', 'q4_k_s', 'q4_0', 'q3_k_m']

/**
 * Provider model capabilities - copied from token.js package
 */
export const providerModels = {
  // OpenAI — set verified against the live /v1/models response on macOS build (Apr 2026).
  // o3-mini is reasoning-only (text), so it is excluded from supportsImages.
  'openai': {
    models: [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5',
      'gpt-5-mini',
      'gpt-4.5-preview',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
      'o3-mini',
      'gpt-4-turbo',
    ],
    supportsCompletion: true,
    supportsStreaming: [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5',
      'gpt-5-mini',
      'gpt-4.5-preview',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
      'o3-mini',
      'gpt-4-turbo',
    ],
    supportsJSON: [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5',
      'gpt-5-mini',
      'gpt-4.5-preview',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
      'o3-mini',
      'gpt-4-turbo',
    ],
    supportsImages: [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5',
      'gpt-5-mini',
      'gpt-4.5-preview',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
    ],
    supportsToolCalls: [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5',
      'gpt-5-mini',
      'gpt-4.5-preview',
      'gpt-4.1',
      'gpt-4o',
      'gpt-4o-mini',
      'o3-mini',
      'gpt-4-turbo',
    ],
    supportsN: true,
  },
  'ai21': {
    models: ['jamba-instruct'],
    supportsCompletion: true,
    supportsStreaming: ['jamba-instruct'],
    supportsJSON: [],
    supportsImages: [],
    supportsToolCalls: [],
    supportsN: true,
  },
  // Anthropic — source: https://platform.claude.com/docs/en/about-claude/models/overview (Apr 21, 2026)
  // Only current/active models. claude-sonnet-4 & claude-opus-4 deprecated (retire 15 Jun 2026).
  // claude-3-* models retired.
  'anthropic': {
    models: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-5',
    ],
    supportsCompletion: true,
    supportsStreaming: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-5',
    ],
    supportsJSON: [],
    supportsImages: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-5',
    ],
    supportsToolCalls: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-5',
    ],
    supportsN: true,
  },
  // Gemini — source: https://ai.google.dev/gemini-api/docs/models (Apr 2026)
  // 3.x line is preview; 2.5.x stable. 2.0-* scheduled for shutdown 1 Jun 2026; 1.5-* retired.
  'gemini': {
    models: [
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
    supportsCompletion: true,
    supportsStreaming: [
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
    supportsJSON: [
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
    supportsImages: [
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
    supportsToolCalls: [
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
    supportsN: true,
  },
  'cohere': {
    models: [
      'command-a-03-2025',
      'command-r-08-2024',
      'command-r-plus-08-2024',
    ],
    supportsCompletion: true,
    supportsStreaming: [
      'command-a-03-2025',
      'command-r-08-2024',
      'command-r-plus-08-2024',
    ],
    supportsJSON: [],
    supportsImages: [],
    supportsToolCalls: [
      'command-a-03-2025',
      'command-r-08-2024',
      'command-r-plus-08-2024',
    ],
    supportsN: true,
  },
  'bedrock': {
    models: [
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'anthropic.claude-3-5-haiku-20241022-v1:0',
      'cohere.command-r-plus-v1:0',
      'cohere.command-r-v1:0',
      'meta.llama3-70b-instruct-v1:0',
      'meta.llama3-8b-instruct-v1:0',
      'mistral.mistral-large-2402-v1:0',
      'amazon.titan-text-express-v1',
    ],
    supportsCompletion: true,
    supportsStreaming: [
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'anthropic.claude-3-5-haiku-20241022-v1:0',
      'cohere.command-r-plus-v1:0',
      'cohere.command-r-v1:0',
      'meta.llama3-70b-instruct-v1:0',
      'meta.llama3-8b-instruct-v1:0',
      'mistral.mistral-large-2402-v1:0',
      'amazon.titan-text-express-v1',
    ],
    supportsJSON: [],
    supportsImages: [
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'anthropic.claude-3-5-haiku-20241022-v1:0',
    ],
    supportsToolCalls: [
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'anthropic.claude-3-5-haiku-20241022-v1:0',
      'cohere.command-r-plus-v1:0',
      'cohere.command-r-v1:0',
      'mistral.mistral-large-2402-v1:0',
    ],
    supportsN: true,
  },
  'mistral': {
    models: [
      'mistral-large-2411',
      'magistral-medium-2509',
      'magistral-small-2509',
      'pixtral-large-2411',
      'pixtral-12b-2409',
      'codestral-2508',
      'mistral-small-2506',
      'mistral-nemo-2407',
    ],
    supportsCompletion: true,
    supportsStreaming: [
      'mistral-large-2411',
      'magistral-medium-2509',
      'magistral-small-2509',
      'pixtral-large-2411',
      'pixtral-12b-2409',
      'codestral-2508',
      'mistral-small-2506',
      'mistral-nemo-2407',
    ],
    supportsJSON: ['mistral-large-2411', 'codestral-2508'],
    supportsImages: [
      'magistral-medium-2509',
      'magistral-small-2509',
      'pixtral-large-2411',
      'pixtral-12b-2409',
      'mistral-small-2506',
    ],
    supportsToolCalls: ['mistral-large-2411', 'mistral-small-2506'],
    supportsN: true,
  },
  'groq': {
    models: [
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'moonshotai/kimi-k2-instruct-0905',
      'qwen/qwen3-32b',
      'openai/gpt-oss-120b',
      'whisper-large-v3-turbo',
    ],
    supportsCompletion: true,
    supportsStreaming: [
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'moonshotai/kimi-k2-instruct-0905',
      'qwen/qwen3-32b',
      'openai/gpt-oss-120b',
    ],
    supportsJSON: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-120b',
    ],
    supportsImages: [
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'meta-llama/llama-4-scout-17b-16e-instruct',
    ],
    supportsToolCalls: [],
    supportsN: true,
  },
  // xAI — source: https://docs.x.ai/developers/models (Apr 2026)
  // grok-4.20 is flagship; 4-1-fast is cost-efficient; code-fast specialized.
  // grok-3/grok-2-vision kept as legacy for thread back-compat.
  'xai': {
    models: [
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4-1-fast-reasoning',
      'grok-4-1-fast-non-reasoning',
      'grok-code-fast-1',
      'grok-3',
      'grok-3-mini',
      'grok-2-vision-1212',
    ],
    supportsCompletion: true,
    supportsStreaming: [
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4-1-fast-reasoning',
      'grok-4-1-fast-non-reasoning',
      'grok-code-fast-1',
      'grok-3',
      'grok-3-mini',
      'grok-2-vision-1212',
    ],
    supportsJSON: [
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4-1-fast-reasoning',
      'grok-4-1-fast-non-reasoning',
      'grok-code-fast-1',
      'grok-3',
      'grok-3-mini',
    ],
    supportsImages: [
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4-1-fast-reasoning',
      'grok-4-1-fast-non-reasoning',
      'grok-2-vision-1212',
    ],
    supportsToolCalls: [
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
      'grok-4-1-fast-reasoning',
      'grok-4-1-fast-non-reasoning',
      'grok-code-fast-1',
      'grok-3',
      'grok-3-mini',
    ],
    supportsN: true,
  },
  'perplexity': {
    models: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
    supportsCompletion: true,
    supportsStreaming: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
    supportsJSON: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
    supportsImages: [],
    supportsToolCalls: ['sonar', 'sonar-pro', 'sonar-reasoning-pro'],
    supportsN: true,
  },
  'minimax': {
    models: [
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
    ],
    supportsCompletion: true,
    supportsStreaming: [
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
    ],
    supportsJSON: [],
    supportsImages: [],
    supportsToolCalls: [
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
    ],
    supportsN: true,
  },
  'openrouter': {
    models: true,
    supportsCompletion: true,
    supportsStreaming: true,
    supportsJSON: true,
    supportsImages: true,
    supportsToolCalls: true,
    supportsN: true,
  },
  'nvidia': {
    models: ['moonshotai/kimi-k2.5', 'minimaxai/minimax-m2.5', 'z-ai/glm5'],
    supportsCompletion: true,
    supportsStreaming: true,
    supportsJSON: true,
    supportsImages: true,
    supportsToolCalls: true,
    supportsN: true,
  },
  // Meta Model API (https://api.meta.ai/v1). The Muse Spark family is one set
  // of weights behind three ids — 1.1, 1.2 and the cheaper 1.2 contributor
  // tier — all multimodal (text/image/video/PDF in) with tool calling.
  'meta': {
    models: ['muse-spark-1.2', 'muse-spark-1.2-contributor', 'muse-spark-1.1'],
    supportsCompletion: true,
    supportsStreaming: true,
    supportsJSON: true,
    supportsImages: [
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.1',
    ],
    supportsToolCalls: [
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.1',
    ],
    supportsN: true,
  },
  'openai-compatible': {
    models: true,
    supportsCompletion: true,
    supportsStreaming: true,
    supportsJSON: true,
    supportsImages: true,
    supportsToolCalls: true,
    supportsN: true,
  },
} as const
