import { useMemo } from 'react'

import { UpdateBanner } from '@/containers/UpdateBanner'
import { useAppUpdater } from '@/hooks/useAppUpdater'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { parseReleaseHighlights } from '@/lib/releaseHighlights'
import { useUpdateBannerSlot } from '@/stores/update-banner-store'

/// Same repository the "What's new" dialog and the release-notes store read.
/// Duplicated rather than shared because each of the three reaches GitHub for
/// its own reason and none of them owns the constant.
const GITHUB_RELEASES_BASE =
  'https://github.com/AtomicBot-ai/Atomic-Chat/releases/tag'

const releaseNotesUrl = (version: string): string =>
  `${GITHUB_RELEASES_BASE}/${version.startsWith('v') ? version : `v${version}`}`

/**
 * Bottom-right offer to update the app itself (ATO-533).
 *
 * Shares `<UpdateBanner />` with the engine banner; what is specific here is
 * the changelog preview, parsed out of the GitHub release body the updater
 * already carries as `updateInfo.body`.
 *
 * "Remind me later" and the × are the same lever on purpose: the app updater
 * has one session-scoped `remindMeLater` flag, reset by the next check or by
 * the button in Settings → General. The engine banner, which owns a persisted
 * snooze, is where the two differ.
 */
const DialogAppUpdater = () => {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { updateState, downloadAndInstallUpdate, setRemindMeLater } =
    useAppUpdater()

  const newVersion = updateState.updateInfo?.version ?? ''
  const isVisible =
    updateState.isUpdateAvailable && !updateState.remindMeLater && !!newVersion
  const mayRender = useUpdateBannerSlot('app', isVisible)

  const highlights = useMemo(
    () => parseReleaseHighlights(updateState.updateInfo?.body),
    [updateState.updateInfo?.body]
  )

  if (!isVisible || !mayRender) return null

  const handleUpdate = () => {
    downloadAndInstallUpdate()
    setRemindMeLater(true)
  }

  const handleShowReleaseNotes = () => {
    const url = releaseNotesUrl(newVersion)
    serviceHub
      .opener()
      .open(url)
      .catch(() => window.open(url, '_blank'))
  }

  return (
    <UpdateBanner
      testId="app-update-banner"
      title={t('updater:app.title')}
      fromVersion={updateState.currentVersion || null}
      toVersion={newVersion}
      subtitle={t('updater:app.subtitle')}
      highlights={highlights.items}
      remainingLabel={
        highlights.remaining > 0
          ? t('updater:app.moreHighlights', { count: highlights.remaining })
          : undefined
      }
      secondaryAction={{
        label: t('updater:showReleaseNotes'),
        onClick: handleShowReleaseNotes,
      }}
      remindLaterLabel={t('updater:remindMeLater')}
      onRemindLater={() => setRemindMeLater(true)}
      updateLabel={t('updater:update')}
      onUpdate={handleUpdate}
      busy={updateState.isDownloading}
      busyLabel={t('updater:downloading')}
      dismissLabel={t('updater:dismiss')}
      onDismiss={() => setRemindMeLater(true)}
    />
  )
}

export default DialogAppUpdater
