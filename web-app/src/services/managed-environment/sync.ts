/**
 * Keeps `useManagedEnvironmentStore` in step with the core: the snapshot first, then the relayed
 * `environment:*` events; the relay's own snapshot on every reattach (`atomic-core://snapshot`,
 * payload `{generation, snapshot}`), and a detach that makes events stop counting until then.
 *
 * Mounted once at the app root on Linux and Windows, not by the provider page: a setup runs whether
 * or not the page is open, and the page must find it as it is when it opens (spec
 * `tensorrt-llm-desktop`, "Закрыли окно и открыли снова").
 */

import {
  useManagedEnvironmentStore,
  type ManagedSnapshotPart,
} from '@/stores/managed-environment-store'
import type { EnvironmentOperation, EnvironmentSnapshot } from './types'

type Unlisten = () => void
export type Listen = (
  name: string,
  handler: (event: { payload: unknown }) => void
) => Promise<Unlisten>

export const ENVIRONMENT_CHANGED_EVENT = 'atomic-core://environment:changed'
export const ENVIRONMENT_OPERATION_EVENT = 'atomic-core://environment:operation'
const CORE_SNAPSHOT_EVENT = 'atomic-core://snapshot'
const CORE_DETACHED_EVENT = 'atomic-core://detached'

export async function startManagedEnvironmentSync(options: {
  listen: Listen
  readSnapshot: () => Promise<ManagedSnapshotPart>
}): Promise<Unlisten> {
  const store = useManagedEnvironmentStore.getState()
  const unlisten = await Promise.all([
    options.listen(ENVIRONMENT_CHANGED_EVENT, (event) =>
      store.applyEnvironment(event.payload as EnvironmentSnapshot)
    ),
    options.listen(ENVIRONMENT_OPERATION_EVENT, (event) =>
      store.applyOperation(event.payload as EnvironmentOperation)
    ),
    options.listen(CORE_SNAPSHOT_EVENT, (event) => {
      const snapshot = (event.payload as { snapshot?: ManagedSnapshotPart })?.snapshot
      if (snapshot?.instance_id) store.applySnapshot(snapshot)
    }),
    options.listen(CORE_DETACHED_EVENT, () => store.detach()),
  ])
  // Listening first: an event that lands between the read and the subscription would be lost.
  try {
    store.applySnapshot(await options.readSnapshot())
  } catch (error) {
    // Not attached yet; the relay emits its snapshot once it is.
    console.debug('[managed-environment] no snapshot yet:', error)
  }
  return () => unlisten.forEach((stop) => stop())
}
