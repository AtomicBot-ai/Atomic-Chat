import { useCallback, useEffect, useMemo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

const REMARK_PLUGINS = [remarkGfm]
const FORCE_UPDATE_PREVIEW = import.meta.env.VITE_FORCE_UPDATE_BANNER === 'true'

/// Release bodies are plain GitHub-flavoured markdown: paragraphs, headings,
/// bullets, links, inline code. Rendered with bare `react-markdown` rather
/// than `<RenderMarkdown />`, which drags streamdown, mermaid, KaTeX and the
/// artifact panel into a 24 rem toast for no gain. Type sizes are inherited
/// from the banner's inset so the notes read like the highlights they replace.
const NOTES_CLASS_NAME = [
  'break-words',
  '[&_p]:mt-1.5 [&_p:first-child]:mt-0',
  '[&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2 [&_h4]:mt-2 [&_h5]:mt-2 [&_h6]:mt-2',
  '[&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0',
  '[&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-[11px] [&_h5]:text-[11px] [&_h6]:text-[11px]',
  '[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold',
  '[&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_h4]:text-foreground [&_h5]:text-foreground [&_h6]:text-foreground',
  '[&_ul]:mt-1 [&_ul]:list-disc [&_ul]:pl-3.5 [&_ol]:mt-1 [&_ol]:list-decimal [&_ol]:pl-3.5',
  '[&_li]:mt-0.5 [&_li_ul]:mt-0.5',
  '[&_strong]:font-medium [&_strong]:text-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[10px]',
  '[&_pre]:mt-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2',
  '[&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-foreground',
  '[&_hr]:my-2',
].join(' ')

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
  const releaseBody = updateState.updateInfo?.body?.trim() ?? ''
  const isVisible =
    updateState.isUpdateAvailable && !updateState.remindMeLater && !!newVersion
  const mayRender = useUpdateBannerSlot('app', isVisible)

  const highlights = useMemo(
    () => parseReleaseHighlights(updateState.updateInfo?.body),
    [updateState.updateInfo?.body]
  )

  // Unfolded notes belong to one offer: a different version folds them back.
  const [notesOpen, setNotesOpen] = useState(FORCE_UPDATE_PREVIEW)
  useEffect(() => {
    setNotesOpen(FORCE_UPDATE_PREVIEW)
  }, [newVersion])

  const openExternal = useCallback(
    (url: string) => {
      serviceHub
        .opener()
        .open(url)
        .catch(() => window.open(url, '_blank'))
    },
    [serviceHub]
  )

  // Links inside the notes leave the app the same way "Open release" does,
  // instead of navigating the webview away from the chat.
  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ href, children, ...props }) => (
        <a
          {...props}
          href={href}
          onClick={(event) => {
            event.preventDefault()
            if (href) openExternal(href)
          }}
        >
          {children}
        </a>
      ),
    }),
    [openExternal]
  )

  if (!isVisible || !mayRender) return null

  const handleUpdate = () => {
    downloadAndInstallUpdate()
    setRemindMeLater(true)
  }

  const handleOpenRelease = () => openExternal(releaseNotesUrl(newVersion))

  // With nothing to unfold, the link still leads somewhere: the release page.
  const handleToggleReleaseNotes = () => {
    if (!releaseBody) {
      handleOpenRelease()
      return
    }
    setNotesOpen((open) => !open)
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
        label: notesOpen
          ? t('updater:hideReleaseNotes')
          : t('updater:showReleaseNotes'),
        onClick: handleToggleReleaseNotes,
      }}
      expanded={notesOpen && !!releaseBody}
      expandedContent={
        releaseBody ? (
          <div className={NOTES_CLASS_NAME}>
            <Markdown
              remarkPlugins={REMARK_PLUGINS}
              components={markdownComponents}
            >
              {releaseBody}
            </Markdown>
          </div>
        ) : undefined
      }
      expandedAction={{
        label: t('updater:openRelease'),
        onClick: handleOpenRelease,
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
