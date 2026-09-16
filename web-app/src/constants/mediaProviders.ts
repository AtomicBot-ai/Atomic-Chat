/**
 * The bundled media-provider baseline.
 *
 * One entry: the built-in engine Radium installs and runs itself (tracker
 * Task 30, decision D39), so a new user can make images with nothing else set
 * up.
 *
 * The Radium Media Worker used to be the baseline. Radium never shipped or
 * started that worker, so it was offline for everyone and the Media page opened
 * on an error. It is retired as a builtin: `RETIRED_BUILTIN_PROVIDER_IDS` drops
 * its untouched builtin copy from saved settings. Anyone who runs a worker can
 * still add one in Settings, where it is saved as their own entry.
 *
 * Task 15 may later feed additional entries from the remote registry; those
 * arrive with `origin: 'registry'` and never overwrite a user's own edits.
 */

import type { MediaProviderDescriptor } from '@/services/media/contract'

export const BUILTIN_ENGINE_PROVIDER_ID = 'builtin-engine'

export const ATOMIC_MEDIA_WORKER_PROVIDER_ID = 'atomic-media-worker'

/** Builtin entries a later release removed; their saved builtin copies go too. */
export const RETIRED_BUILTIN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  ATOMIC_MEDIA_WORKER_PROVIDER_ID,
])

export const BASELINE_MEDIA_PROVIDERS: MediaProviderDescriptor[] = [
  {
    id: BUILTIN_ENGINE_PROVIDER_ID,
    label: 'Built-in engine',
    kind: 'local_engine',
    adapter: 'builtin-engine',
    // Runs on this computer, started by Radium: nothing to authenticate.
    auth: { type: 'none' },
    enabled: true,
    origin: 'builtin',
    order: 0,
  },
]
