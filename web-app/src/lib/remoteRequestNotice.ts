/**
 * A device asking this computer for access, wherever the person is.
 *
 * A request expires after ten minutes and waits for "Allow" on the Remote
 * models page, so it has to reach the person off that page too:
 * - window hidden, minimized or behind another app: one OS notification per
 *   request (the Settings switch can silence it);
 * - window in front on another page: the corner card, which waits there and
 *   shows again whenever the window comes back while the request is pending;
 * - the Remote models page on screen: the page lists it, nothing else does.
 *
 * The desktop notification plugin has no click handler, so the OS
 * notification only says where to go; the corner card is what points there.
 */

import { platformLabel } from '@/lib/account'
import type { RemotePendingRequest } from '@/services/account/remote-types'

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * The requests not seen before, in order, each recorded in `announced` so it
 * comes out once per run. One that was pending when the app started counts
 * as new.
 */
export function takeNewRequests(
  requests: readonly RemotePendingRequest[],
  announced: Set<string>
): RemotePendingRequest[] {
  const fresh: RemotePendingRequest[] = []
  for (const request of requests) {
    if (announced.has(request.grantId)) continue
    announced.add(request.grantId)
    fresh.push(request)
  }
  return fresh
}

/**
 * The requests the corner card lists: pending ones the person has neither
 * put away there nor seen on the Remote models page. None while that page is
 * open, since it lists them itself.
 */
export function requestsForCorner(
  requests: readonly RemotePendingRequest[],
  acknowledged: readonly string[],
  onRemotePage: boolean
): RemotePendingRequest[] {
  if (onRemotePage) return []
  return requests.filter((request) => !acknowledged.includes(request.grantId))
}

/**
 * `acknowledged` without the requests that are no longer pending: allowed,
 * denied or expired. A grant id never comes back as a new request.
 */
export function keepPending(
  acknowledged: readonly string[],
  requests: readonly RemotePendingRequest[]
): string[] {
  const pending = new Set(requests.map((request) => request.grantId))
  return acknowledged.filter((grantId) => pending.has(grantId))
}

/** The device's own name, else "<platform> device", else "Unknown device". */
export function requestDeviceName(
  t: Translate,
  request: Pick<RemotePendingRequest, 'deviceName' | 'platform'>
): string {
  const name = request.deviceName?.trim()
  if (name) return name
  const platform = platformLabel(request.platform)
  return platform
    ? t('account:devices.platformDevice', { platform })
    : t('account:remote.unknownDevice')
}
