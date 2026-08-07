/**
 * Bundled fallback for the staff-picks registry. Mirrors the contents of
 * `atomic-chat-conf/models/staff-picks.json` so Hub can render the curated
 * list on the very first launch (before the manifest fetch resolves) and when
 * the network is unavailable.
 *
 * Platform filtering happens at runtime in `staff-picks-registry.ts` — keep
 * `platforms` declarative here (do NOT inline `IS_MACOS` ternaries) so the
 * baseline mirrors the manifest shape verbatim.
 */

import type { StaffPick } from '@/services/staff-picks-registry'

export const BASELINE_STAFF_PICKS: ReadonlyArray<StaffPick> = [
  {
    model_name: 'AtomicChat/Qwen3.5-4B-GGUF',
    title: 'Qwen3.5 4B',
    summary: 'Compact all-rounder that runs comfortably on almost any machine.',
    description_key: 'hub:recEverydayUse',
    icon: 'qwen',
    categories: ['general', 'compact', 'tools'],
    order: 10,
  },
  {
    model_name: 'AtomicChat/gemma-4-E4B-it-GGUF',
    title: 'Gemma 4 E4B',
    summary: "Google's efficient multimodal model with vision input.",
    description_key: 'hub:recVisionKnowledge',
    icon: 'gemma',
    categories: ['general', 'vision', 'compact'],
    order: 20,
  },
  {
    model_name: 'AtomicChat/Qwen3.5-9B-GGUF',
    title: 'Qwen3.5 9B',
    summary: 'Stronger reasoning while still fitting a 16 GB machine.',
    description_key: 'hub:recMathReasoning',
    icon: 'qwen',
    categories: ['general', 'reasoning', 'tools'],
    order: 30,
  },
  {
    model_name: 'AtomicChat/gemma-4-12b-it-GGUF',
    title: 'Gemma 4 12B',
    summary: 'Mid-size Gemma 4 with vision and long-context support.',
    description_key: 'hub:recVisionKnowledge',
    icon: 'gemma',
    categories: ['general', 'vision', 'multilingual'],
    order: 40,
  },
  {
    model_name: 'AtomicChat/qwen3-coder-30b-a3b-GGUF',
    title: 'Qwen3 Coder 30B A3B',
    summary: 'Sparse coding specialist: 30B total parameters, 3B active.',
    description_key: 'hub:recCoding',
    icon: 'qwen',
    categories: ['coding', 'tools'],
    order: 50,
  },
  {
    model_name: 'AtomicChat/qwen36-27b-GGUF',
    title: 'Qwen3.6 27B',
    summary: 'Prioritizes stability and real-world coding quality.',
    description_key: 'hub:recCoding',
    icon: 'qwen',
    categories: ['reasoning', 'coding', 'tools'],
    order: 60,
  },
  {
    model_name: 'AtomicChat/gemma-4-31B-it-GGUF',
    title: 'Gemma 4 31B',
    summary: 'Largest Gemma 4 variant for workstations with plenty of memory.',
    description_key: 'hub:recVisionKnowledge',
    icon: 'gemma',
    categories: ['general', 'vision', 'reasoning'],
    order: 70,
  },
  {
    model_name: 'AtomicChat/gemma4-e4b-it-GGUF',
    title: 'Gemma 4 E4B (imatrix)',
    summary: 'Importance-matrix quantizations of Gemma 4 E4B, vision included.',
    description_key: 'hub:recEverydayUse',
    icon: 'gemma',
    categories: ['general', 'vision', 'compact'],
    order: 80,
  },
  {
    model_name: 'AtomicChat/qwen35-4b-GGUF',
    title: 'Qwen3.5 4B (imatrix)',
    summary: 'Importance-matrix quantizations of the compact Qwen3.5 4B.',
    description_key: 'hub:recEverydayUse',
    icon: 'qwen',
    categories: ['general', 'compact'],
    order: 90,
  },
  {
    model_name: 'unsloth/Llama-3.2-3B-Instruct-GGUF',
    title: 'Llama 3.2 3B Instruct',
    summary: 'Small Llama for chat and fine-tuning experiments.',
    description_key: 'hub:recFinetuningChat',
    icon: 'llama',
    categories: ['general', 'compact'],
    platforms: ['windows', 'linux'],
    order: 100,
  },
  {
    model_name: 'mlx-community/gemma-4-e4b-it-4bit',
    title: 'Gemma 4 E4B (MLX)',
    summary: 'Apple Silicon build of Gemma 4 E4B running on MLX.',
    description_key: 'hub:recForMlx',
    icon: 'gemma',
    categories: ['general', 'vision', 'compact'],
    platforms: ['macos'],
    order: 110,
  },
  {
    model_name: 'mlx-community/Qwen3.5-9B-MLX-4bit',
    title: 'Qwen3.5 9B (MLX)',
    summary: 'Apple Silicon build of Qwen3.5 9B with vision support.',
    description_key: 'hub:recForMlx',
    icon: 'qwen',
    categories: ['general', 'vision', 'reasoning'],
    platforms: ['macos'],
    order: 120,
  },
]
