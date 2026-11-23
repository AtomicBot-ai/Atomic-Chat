import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { IconDevices } from '@tabler/icons-react'

import { route } from '@/constants/routes'
import {
  CORNER_CARD,
  CORNER_PRIMARY_ACTION,
  CORNER_ROW,
  CornerCardHeader,
  CornerMini,
} from '@/containers/corner/CornerCard'
import { CORNER_ORDER, CornerSlot } from '@/containers/corner/cornerStack'
import { useAutoCollapse } from '@/containers/corner/useAutoCollapse'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isPathActive } from '@/lib/navigation'
import { isWindowAway } from '@/lib/notifications'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { requestDeviceName, requestsForCorner } from '@/lib/remoteRequestNotice'
import { cn } from '@/lib/utils'
import type { RemotePendingRequest } from '@/services/account/remote-types'
import { useAccountRemoteStore } from '@/stores/account-remote-store'

/**
 * Devices asking for access to this computer's models, in the corner column
 * on every page but Remote models (which lists them itself), until each is
 * allowed, denied, expired or put away with ×. A request seen on that page
 * does not come back here. Accounts flag only.
 */
export function RemoteRequestNotice() {
  return PlatformFeatures[PlatformFeature.ACCOUNTS] ? <PendingRequests /> : null
}

function PendingRequests() {
  const navigate = useNavigate()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const onRemotePage = isPathActive(pathname, route.account.remote, true)
  const requests = useAccountRemoteStore((state) => state.status.requests)
  const acknowledged = useAccountRemoteStore(
    (state) => state.acknowledgedRequests
  )
  const acknowledge = useAccountRemoteStore(
    (state) => state.acknowledgeRequests
  )

  // The page lists them: leaving it without a decision does not bring the
  // card back for them.
  useEffect(() => {
    if (onRemotePage && requests.length > 0) {
      acknowledge(requests.map((request) => request.grantId))
    }
  }, [onRemotePage, requests, acknowledge])

  const shown = useMemo(
    () => requestsForCorner(requests, acknowledged, onRemotePage),
    [requests, acknowledged, onRemotePage]
  )

  return (
    <RemoteRequestCard
      requests={shown}
      onReview={() => void navigate({ to: route.account.remote })}
      onDismiss={() => acknowledge(shown.map((request) => request.grantId))}
    />
  )
}

/**
 * The card: who asks and the check code to compare, and "Review", which opens
 * Remote models where Allow and Deny are. Like every corner card it folds
 * into a pill three seconds after it appears; another device asking, or the
 * person coming back to the window, opens it again for three seconds. The OS
 * notification sent while the window was away cannot open the request (the
 * desktop notification plugin has no click handler), so this is what points
 * to it once the window is back.
 */
function RemoteRequestCard({
  requests,
  onReview,
  onDismiss,
}: {
  requests: RemotePendingRequest[]
  onReview: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const visible = requests.length > 0
  const { collapsed, expand, collapse, peek, holdProps } =
    useAutoCollapse(visible)

  // A device joining the ones already shown opens the card again. Not the
  // first ones: that is an appearance, which `useAutoCollapse` opens.
  const seenIds = useRef(new Set(requests.map((request) => request.grantId)))
  useLayoutEffect(() => {
    const seen = seenIds.current
    const joined =
      seen.size > 0 && requests.some((request) => !seen.has(request.grantId))
    seenIds.current = new Set(requests.map((request) => request.grantId))
    if (joined) peek()
  }, [requests, peek])

  useEffect(() => {
    if (!visible) return
    const back = () => {
      if (!isWindowAway()) peek()
    }
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    return () => {
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [visible, peek])

  if (!visible) return null

  const title = t('account:remote.notice.title')

  if (collapsed) {
    return (
      <CornerSlot order={CORNER_ORDER.accessRequest}>
        <CornerMini
          icon={<IconDevices size={15} aria-hidden />}
          text={title}
          count={requests.length}
          label={t('account:remote.notice.expand')}
          onClick={expand}
          testId="remote-request-notice-mini"
        />
      </CornerSlot>
    )
  }

  return (
    <CornerSlot order={CORNER_ORDER.accessRequest}>
      <div
        role="status"
        aria-live="polite"
        data-testid="remote-request-notice"
        className={CORNER_CARD}
        {...holdProps}
      >
        <CornerCardHeader
          title={title}
          count={requests.length}
          collapseLabel={t('account:remote.notice.collapse')}
          onCollapse={collapse}
          dismissLabel={t('account:remote.notice.dismiss')}
          onDismiss={onDismiss}
        />
        <ul className="max-h-48 divide-y divide-[var(--dl-divider)] overflow-y-auto">
          {requests.map((request) => (
            <li
              key={request.grantId}
              className={cn(CORNER_ROW, 'flex items-center gap-3')}
            >
              <span className="flex shrink-0 text-[var(--dl-strong)]">
                <IconDevices size={18} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-[var(--dl-title)]">
                  {requestDeviceName(t, request)}
                </p>
                <p className="mt-0.5 truncate text-[11px] tabular-nums text-[var(--dl-text)]">
                  {t('account:remote.notice.checkCode', {
                    code: request.checkCode,
                  })}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-end gap-1 border-t border-[var(--dl-divider)] px-2 py-2">
          <button
            type="button"
            className={CORNER_PRIMARY_ACTION}
            onClick={onReview}
          >
            {t('account:remote.notice.review')}
          </button>
        </div>
      </div>
    </CornerSlot>
  )
}
