import { useEngineVersionBackend } from '@/hooks/useDecisionEngineReadiness'
import {
  EMBEDDING_ENGINE,
  embeddingEngineReadiness,
  type EmbeddingEngineReadiness,
} from '@/lib/embedding/engine'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'

/** Whether the configured stock llama.cpp build is new enough to start `model`. */
export function useEmbeddingEngineReadiness(
  model: Pick<EmbeddingCatalogModel, 'min_engine'>
): EmbeddingEngineReadiness {
  return embeddingEngineReadiness(
    model,
    useEngineVersionBackend(EMBEDDING_ENGINE)
  )
}
