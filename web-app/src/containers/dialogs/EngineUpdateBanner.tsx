import { toast } from 'sonner'

import { UpdateBanner } from '@/containers/UpdateBanner'
import { useEngineUpdate } from '@/hooks/useEngineUpdate'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes, getProviderTitle } from '@/lib/utils'
import { useUpdateBannerSlot } from '@/stores/update-banner-store'

/**
 * Bottom-right offer to update an inference engine (ATO-528 / ATO-531).
 *
 * The llama.cpp extensions used to download a new release tag on their own at
 * startup; they now publish an offer and this asks. Accepting hands the
 * transfer back to the extension, whose progress `<BackendUpdater />` renders —
 * which is why this banner disappears the moment "Update" is pressed rather
 * than growing a progress bar of its own.
 */
const EngineUpdateBanner = () => {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { offer, isApplying, applyUpdate, remindLater, dismiss } =
    useEngineUpdate()

  const mayRender = useUpdateBannerSlot('engine', !!offer)
  if (!offer || !mayRender) return null

  const sizeLine = offer.downloadSizeBytes
    ? t('updater:engine.downloadSize', {
        size: formatBytes(offer.downloadSizeBytes),
      })
    : null
  const restartLine = offer.restartRequired
    ? t('updater:engine.restartRequired')
    : t('updater:engine.noRestartNeeded')
  const subtitle = [sizeLine, restartLine].filter(Boolean).join(' · ')

  const handleUpdate = () => {
    void applyUpdate().catch(() => {
      toast.error(t('updater:engine.updateFailed'))
    })
  }

  const handleShowNotes = offer.releaseNotesUrl
    ? () => {
        const url = offer.releaseNotesUrl as string
        serviceHub
          .opener()
          .open(url)
          .catch(() => window.open(url, '_blank'))
      }
    : undefined

  return (
    <UpdateBanner
      testId="engine-update-banner"
      title={t('updater:engine.title', {
        engine: getProviderTitle(offer.provider),
      })}
      fromVersion={offer.currentVersion || null}
      toVersion={offer.targetVersion}
      subtitle={subtitle}
      secondaryAction={
        handleShowNotes
          ? { label: t('updater:engine.showWhatsNew'), onClick: handleShowNotes }
          : undefined
      }
      remindLaterLabel={t('updater:remindMeLater')}
      onRemindLater={remindLater}
      updateLabel={t('updater:update')}
      onUpdate={handleUpdate}
      busy={isApplying}
      busyLabel={t('updater:starting')}
      dismissLabel={t('updater:dismiss')}
      onDismiss={dismiss}
    />
  )
}

export default EngineUpdateBanner
