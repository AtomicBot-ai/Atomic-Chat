import { HuggingFaceAuthorAvatar } from '@/components/HuggingFaceAuthorAvatar'
import { ModelFitIndicator } from '@/containers/ModelFitIndicator'
import { FamilyLogoMark } from '@/containers/ModelLogo'
import { SetupModelRow } from '@/containers/SetupModelRow'
import { fitLabelKey, fitLevel } from '@/containers/SetupScreenHelpers'
import type { RecommendedDownload } from '@/hooks/useRecommendedDownloads'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { iconKeyLogoSrc, modelFamilyLogoSrc } from '@/lib/model-logo'

type RecommendedDownloadRowProps = {
  'item': RecommendedDownload
  'hero': boolean
  'progressText'?: string | null
  'downloading'?: boolean
  'disabled'?: boolean
  'onDownload': () => void
  'data-testid'?: string
}

/**
 * The recommendation row shared by Welcome, Select Model and the queued-send
 * dialog. It deliberately delegates its geometry to `SetupModelRow`, so the
 * three surfaces cannot drift on icon, badge, size or action placement again.
 */
export function RecommendedDownloadRow({
  item,
  hero,
  progressText = null,
  downloading = item.isDownloading,
  disabled = false,
  onDownload,
  'data-testid': testId,
}: RecommendedDownloadRowProps) {
  const { t } = useTranslation()
  const level = fitLevel(item.fit)
  const fitTip = level
    ? t(
        `setup:recommend.${{ ok: 'fitTipOk', warn: 'fitTipWarn', no: 'fitTipNo' }[level]}`
      )
    : ''
  const fitMark = level ? (
    <ModelFitIndicator
      level={level}
      label={`${t(fitLabelKey(level))}. ${fitTip}`}
      reason={fitTip}
    />
  ) : null

  const author = item.model.developer?.trim() || item.repo.split('/')[0] || ''
  const initials =
    item.title.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) ||
    author.slice(0, 2) ||
    '?'
  const logo = iconKeyLogoSrc(item.icon) ?? modelFamilyLogoSrc(item.repo)
  const icon = logo ? (
    <FamilyLogoMark src={logo} className="size-8 shrink-0 rounded-md" />
  ) : (
    <HuggingFaceAuthorAvatar
      author={author}
      initials={initials}
      className="size-8 shrink-0"
    />
  )

  const catalogDescription = item.model.description?.trim()
  const readableCatalogDescription =
    catalogDescription && !/^\*\*Tags\*\*\s*:/i.test(catalogDescription)
      ? catalogDescription
      : null
  const summary = item.summary?.trim() || readableCatalogDescription || null

  return (
    <SetupModelRow
      icon={icon}
      title={item.title}
      fitMark={fitMark}
      hero={hero}
      downloadSize={item.sizeLabel}
      progressText={progressText}
      summary={summary}
      rowDownloading={downloading}
      disabled={disabled || item.isDownloading}
      onDownload={onDownload}
      buttonLabel={t('hub:download')}
      buttonAriaLabel={t('chat:replyGate.downloadLabel', {
        name: item.title,
      })}
      data-testid={testId}
    />
  )
}
