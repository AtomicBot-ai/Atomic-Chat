/// <reference types="vite/client" />

/**
 * Optional build-time registry overrides. Every one defaults to unset, which
 * means the app uses the snapshot bundled in `src/registries/` and fetches
 * nothing. See `src/lib/registry-source.ts`.
 */
interface ImportMetaEnv {
  readonly VITE_PROVIDER_REGISTRY_URL?: string
  readonly VITE_RECOMMENDED_MODELS_REGISTRY_URL?: string
  readonly VITE_STAFF_PICKS_REGISTRY_URL?: string
  readonly VITE_MEDIA_REGISTRY_URL?: string
  readonly VITE_MODEL_CATALOG_URL?: string
  readonly VITE_MODEL_CATALOG_INDEX_URL?: string
  readonly VITE_TTFT_TIMING?: string
}
