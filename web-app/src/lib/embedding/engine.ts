/**
 * Where embedding models run, and whether the installed engine is new enough
 * for one.
 *
 * Every embedding model runs on stock llama.cpp (`llamacpp-upstream`), so
 * both answers are the decision models' for that engine: the same hosts, and
 * the same build comparison of the catalog's `min_engine` against the
 * provider's `version_backend` (`b11454/macos-arm64`). A model whose floor is
 * newer than the configured build is shown as needing an update before anyone
 * presses Start; the core keeps the last word (`EMBEDDING_ENGINE_UNSUPPORTED`).
 */

import {
  DECISION_ENGINE_UI,
  upstreamEngineReadiness,
  type DecisionEngineReadiness,
} from '@/lib/decision/engine'
import { isDecisionHostSupported } from '@/lib/decision/platform'
import type {
  EmbeddingCatalogModel,
  EmbeddingEngine,
} from '@/services/embedding-catalog-registry'

/** The provider that runs embedding models: its settings page and its backend updater. */
export const EMBEDDING_ENGINE: EmbeddingEngine = 'llamacpp-upstream'

/** Its backend updater and its name in the UI, shared with the decision models. */
export const EMBEDDING_ENGINE_UI = DECISION_ENGINE_UI[EMBEDDING_ENGINE]

export type EmbeddingEngineReadiness = DecisionEngineReadiness

/** Whether `model` can start on the configured stock llama.cpp build (`versionBackend`). */
export function embeddingEngineReadiness(
  model: Pick<EmbeddingCatalogModel, 'min_engine'>,
  versionBackend: string | undefined
): EmbeddingEngineReadiness {
  return upstreamEngineReadiness(model.min_engine, versionBackend)
}

/**
 * Whether stock llama.cpp ships a build for this desktop: macOS on Apple
 * silicon, Windows on x64 and arm64, Linux on x64. An arch not reported yet
 * counts as supported, so the page does not flicker away while the hardware
 * facts load.
 */
export function isEmbeddingHostSupported(arch: string | undefined): boolean {
  return isDecisionHostSupported(arch, EMBEDDING_ENGINE)
}
