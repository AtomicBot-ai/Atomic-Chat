/**
 * Resolves a provider descriptor to a live adapter.
 *
 * The single place that knows which adapter implementations exist. Everything
 * else - the store, the job manager, the UI - works with the descriptor and the
 * `MediaProviderAdapter` interface, so adding a provider means adding one case
 * here and nothing else.
 */

import { createAtomicWorkerAdapter } from './adapters/atomicWorker'
import { createBuiltinEngineAdapter } from './adapters/builtinEngine'
import { createComfyUiAdapter } from './adapters/comfyui'
import { createRemoteHttpAdapter } from './adapters/remoteHttp'
import { readMediaSecret } from './secrets'
import type { MediaProviderAdapter, MediaProviderDescriptor } from './contract'

export class UnknownMediaAdapterError extends Error {
  constructor(readonly descriptor: MediaProviderDescriptor) {
    super(
      `No media adapter is bundled for "${descriptor.adapter}" ` +
        `(provider "${descriptor.id}").`
    )
    this.name = 'UnknownMediaAdapterError'
  }
}

export function createMediaAdapter(
  descriptor: MediaProviderDescriptor
): MediaProviderAdapter {
  switch (descriptor.adapter) {
    case 'builtin-engine':
      return createBuiltinEngineAdapter(descriptor)
    case 'atomic-media-worker':
      return createAtomicWorkerAdapter(descriptor)
    case 'comfyui':
      return createComfyUiAdapter(descriptor)
    case 'openai-images':
    case 'custom-http':
      // The credential is fetched per request, from the OS credential store,
      // and never cached on the descriptor or in this module. Task 18 / D14.
      //
      // The adapter still refuses to build a request when this resolves to
      // nothing, rather than sending a blank Authorization header - a provider
      // with no key configured says so, instead of producing an opaque 401.
      return createRemoteHttpAdapter(descriptor, {
        resolveSecret: readMediaSecret,
      })
    default:
      // Thrown rather than returning a null adapter: a provider configured
      // against an adapter this build does not have is a state the settings UI
      // must surface, not silently treat as offline.
      throw new UnknownMediaAdapterError(descriptor)
  }
}
