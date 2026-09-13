/**
 * The Radium Media Worker adapter.
 *
 * This is where `@/services/atomicMedia` stops being an app-wide dependency and
 * becomes one provider's private implementation detail. Everything above this
 * file sees only the contract.
 *
 * Honest about v1's limits rather than papering over them: there is no cancel
 * endpoint, so `cancel` is not implemented and `features.cancel` is false. Task 7
 * disables the affordance instead of offering a button that lies (coupling C11).
 */

import {
  AtomicMediaClient,
  AtomicMediaClientError,
} from '@/services/atomicMedia/client'
import type {
  AtomicMediaCapabilities,
  AtomicMediaJobSnapshot,
} from '@/services/atomicMedia/types'

import {
  MEDIA_CONTRACT_MAX_SUPPORTED,
  downcastV2Request,
  upcastV1Capabilities,
} from '../contract'
import type {
  MediaCapabilities,
  MediaJobHandle,
  MediaJobSnapshot,
  MediaJobState,
  MediaModelDescriptor,
  MediaOutputRef,
  MediaProviderAdapter,
  MediaProviderDescriptor,
  MediaProviderHealth,
  NormalizedMediaRequest,
} from '../contract'

const JOB_STATE: Record<string, MediaJobState> = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
}

function detailOf(error: unknown): string {
  if (error instanceof AtomicMediaClientError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** An empty but valid v2 payload, for a worker with no capabilities endpoint. */
function emptyCapabilities(providerId: string): MediaCapabilities {
  return {
    contract_version: 2,
    provider_id: providerId,
    devices: [],
    models: [],
    features: {
      cancel: false,
      progress: true,
      queue: true,
      events: false,
      install: false,
      batch: false,
    },
  }
}

/**
 * A worker that already speaks v2 is trusted for its content but not for its
 * identity: the provider id and the ids qualified with it come from the local
 * descriptor, because that is what the app's selection state is keyed on. A
 * worker cannot know what this install calls it.
 */
function withLocalIdentity(
  payload: MediaCapabilities,
  providerId: string
): MediaCapabilities {
  return {
    ...payload,
    provider_id: providerId,
    models: (payload.models ?? []).map((model) => ({
      ...model,
      provider_id: providerId,
      id: `${providerId}:${model.local_id}`,
    })),
  }
}

export function createAtomicWorkerAdapter(
  descriptor: MediaProviderDescriptor
): MediaProviderAdapter {
  const client = new AtomicMediaClient(descriptor.base_url)

  /**
   * The v1 worker does not echo the caller's `client_job_id`, so the mapping to
   * its own job id lives here. Without it a caller cannot correlate a poll with
   * what it submitted.
   */
  const providerJobIds = new Map<string, string>()

  /** Last capabilities seen, so `submit` can resolve a resolution to w/h. */
  let known: MediaCapabilities | undefined

  const modelFor = (modelId: string): MediaModelDescriptor | undefined =>
    known?.models.find((model) => model.id === modelId)

  function snapshotOf(
    wire: AtomicMediaJobSnapshot,
    handle: MediaJobHandle
  ): MediaJobSnapshot {
    const state = JOB_STATE[wire.status] ?? 'failed'
    const failed = state === 'failed'

    const outputs: MediaOutputRef[] =
      !failed && wire.output_path
        ? [{ kind: 'local_path', path: wire.output_path }]
        : []

    return {
      // Reattached, never read from the wire: see providerJobIds above.
      client_job_id: handle.client_job_id,
      provider_job_id: wire.job_id,
      provider_id: descriptor.id,
      state,
      progress: wire.progress ?? null,
      queue_position: wire.queue_position ?? null,
      outputs,
      error: failed
        ? {
            // v1 reports only a string, so the code cannot be more specific
            // than "the worker failed", and retryability is unknowable. Saying
            // retryable: true here would make Task 7 retry a doomed job.
            code: 'worker_error',
            message: wire.error ?? 'The worker did not say why the job failed.',
            retryable: false,
          }
        : null,
    }
  }

  return {
    descriptor,

    async health(signal?: AbortSignal): Promise<MediaProviderHealth> {
      try {
        const health = await client.health(signal)
        return {
          state: 'online',
          service: health.service,
          version: health.version,
        }
      } catch (error) {
        // Offline is a state to render, not an exception to throw: the settings
        // surface has to be able to say *why* a provider is unavailable.
        const status =
          error instanceof AtomicMediaClientError ? error.status : undefined
        return {
          state: status === 401 || status === 403 ? 'unauthorised' : 'offline',
          detail: detailOf(error),
        }
      }
    },

    async capabilities(signal?: AbortSignal): Promise<MediaCapabilities> {
      const payload = await client.capabilities(signal)
      if (!payload) {
        known = emptyCapabilities(descriptor.id)
        return known
      }

      const version = (payload as AtomicMediaCapabilities).contract_version ?? 1
      if (version > MEDIA_CONTRACT_MAX_SUPPORTED) {
        throw new AtomicMediaClientError(
          `Provider "${descriptor.label}" speaks media contract v${version}; ` +
            `this build understands up to v${MEDIA_CONTRACT_MAX_SUPPORTED}. ` +
            'A newer Radium is needed.',
          'invalid_response',
          { details: { contract_version: version } }
        )
      }

      known =
        version >= 2
          ? withLocalIdentity(
              payload as unknown as MediaCapabilities,
              descriptor.id
            )
          : upcastV1Capabilities(payload as AtomicMediaCapabilities, descriptor.id)

      return known
    },

    async submit(
      req: NormalizedMediaRequest,
      signal?: AbortSignal
    ): Promise<MediaJobSnapshot> {
      const wire = await client.createJob(
        downcastV2Request(req, modelFor(req.model_id)),
        signal
      )
      providerJobIds.set(req.client_job_id, wire.job_id)
      return snapshotOf(wire, {
        client_job_id: req.client_job_id,
        provider_job_id: wire.job_id,
      })
    },

    async poll(
      handle: MediaJobHandle,
      signal?: AbortSignal
    ): Promise<MediaJobSnapshot> {
      const providerJobId =
        handle.provider_job_id ?? providerJobIds.get(handle.client_job_id)
      if (!providerJobId) {
        throw new AtomicMediaClientError(
          `No Radium Media Worker job is known for client job "${handle.client_job_id}".`,
          'invalid_response'
        )
      }
      return snapshotOf(await client.getJob(providerJobId, signal), {
        client_job_id: handle.client_job_id,
        provider_job_id: providerJobId,
      })
    },

    // No cancel, subscribe or install: the v1 worker offers no endpoint for any
    // of them, and features.* says so. The conformance suite asserts that the
    // presence of these methods matches what capabilities claims.
  }
}
