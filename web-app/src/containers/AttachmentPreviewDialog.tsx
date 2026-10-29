import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { fs } from '@janhq/core'
import {
  IconExternalLink,
  IconFileOff,
  IconFolderOpen,
  IconLoader2,
} from '@tabler/icons-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  attachmentPreviewExtension,
  attachmentPreviewMediaType,
  classifyAttachmentPreview,
  type AttachmentPreviewKind,
} from '@/lib/attachment-preview'
import { isPlatformTauri } from '@/lib/platform/utils'
import { readFileBytes, readFileHead } from '@/lib/readFileBytes'
import {
  MAX_BLOB_CLIP_BYTES,
  webviewReadsAssetMedia,
} from '@/lib/video/webview-playback'
import { cn, formatBytes } from '@/lib/utils'
import { AudioPlayer } from './AudioPlayer'
import { HtmlArtifact } from './HtmlArtifact'
import { RenderMarkdown } from './RenderMarkdown'

/** What the dialog previews: a file on disk, or bytes already in memory. */
export type AttachmentPreviewSource = {
  name: string
  /** Absolute path of a local file (documents, video). */
  path?: string
  /** A `data:` or `blob:` URL the app already holds (images, audio). */
  url?: string
  mimeType?: string
  fileType?: string
  size?: number
  /** Text already extracted when the document was attached. */
  inlineContent?: string
}

/** How much of a text file the dialog reads and shows. */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024

/** Kinds read as text, either from disk or through the document parser. */
const TEXT_KINDS: ReadonlySet<AttachmentPreviewKind> = new Set([
  'text',
  'markdown',
  'html',
  'extracted',
])

/** Kinds that fill a fixed-height frame rather than sizing to content. */
const FRAMED_KINDS: ReadonlySet<AttachmentPreviewKind> = new Set([
  'pdf',
  ...TEXT_KINDS,
])

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; src?: string; text?: string; truncated?: boolean }
  | { status: 'missing' }
  | { status: 'failed' }

function Notice({
  children,
  action,
}: {
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
      <IconFileOff className="size-8" />
      <p className="max-w-sm text-sm break-words">{children}</p>
      {action}
    </div>
  )
}

function useAttachmentContent(
  source: AttachmentPreviewSource,
  kind: AttachmentPreviewKind,
  mediaType: string | undefined
): LoadState {
  const serviceHub = useServiceHub()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    let blobUrl: string | undefined
    const settle = (next: LoadState) => {
      if (!cancelled) setState(next)
    }

    const load = async () => {
      const { path, url, inlineContent, fileType } = source
      if (kind === 'unsupported') return settle({ status: 'ready' })
      if (url) return settle({ status: 'ready', src: url })
      if (!path || !isPlatformTauri()) {
        return inlineContent
          ? settle({ status: 'ready', text: inlineContent })
          : settle({ status: 'failed' })
      }

      const stat = await fs.fileStat(path).catch(() => undefined)
      if (!stat || stat.isDirectory) return settle({ status: 'missing' })

      if (kind === 'extracted') {
        const text =
          inlineContent ||
          (await serviceHub.rag().parseDocument?.(path, fileType)) ||
          ''
        return settle({
          status: 'ready',
          text: text.slice(0, TEXT_PREVIEW_MAX_BYTES),
          truncated: text.length > TEXT_PREVIEW_MAX_BYTES,
        })
      }
      if (TEXT_KINDS.has(kind)) {
        const head = await readFileHead(path, TEXT_PREVIEW_MAX_BYTES)
        return settle({
          status: 'ready',
          text: new TextDecoder().decode(head.bytes),
          truncated: head.truncated,
        })
      }
      // WebKitGTK's player cannot read the asset protocol (see
      // `webview-playback.ts`), so media is handed over as a blob there.
      if ((kind === 'audio' || kind === 'video') && !webviewReadsAssetMedia()) {
        const { bytes } = await readFileBytes(path, {
          maxBytes: MAX_BLOB_CLIP_BYTES,
        })
        blobUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
        if (cancelled) return
        return settle({ status: 'ready', src: blobUrl })
      }
      return settle({ status: 'ready', src: convertFileSrc(path) })
    }

    load().catch((error) => {
      console.error('Failed to preview attachment:', error)
      settle({ status: 'failed' })
    })
    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [kind, mediaType, serviceHub, source])

  return state
}

function AttachmentPreviewBody({
  source,
  kind,
  openAction,
}: {
  source: AttachmentPreviewSource
  kind: AttachmentPreviewKind
  openAction?: ReactNode
}) {
  const { t } = useTranslation('chat')
  const mediaType = attachmentPreviewMediaType(
    source.name,
    source.fileType,
    source.mimeType
  )
  const state = useAttachmentContent(source, kind, mediaType)
  // The webview can refuse a codec inside a container it otherwise supports
  // (e.g. HEVC in .mp4), so playback failures are kept apart from read errors.
  const [unplayable, setUnplayable] = useState(false)

  if (kind === 'unsupported') {
    return (
      <Notice action={openAction}>{t('attachmentPreview.unsupported')}</Notice>
    )
  }
  if (state.status === 'loading') {
    return (
      <div className="flex h-full min-h-48 items-center justify-center">
        <IconLoader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (state.status === 'missing') {
    return (
      <Notice>{t('attachmentPreview.missing', { path: source.path })}</Notice>
    )
  }
  if (state.status === 'failed') {
    return <Notice action={openAction}>{t('attachmentPreview.failed')}</Notice>
  }

  const { src, text, truncated } = state

  if (kind === 'image' && src) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-muted/20 p-4">
        <img
          src={src}
          alt={source.name}
          className="max-h-[70vh] max-w-full rounded-md object-contain"
        />
      </div>
    )
  }
  if (kind === 'video' && src) {
    // WebKitGTK answers from the GStreamer registry without building a
    // pipeline; mounting a clip it cannot demux can hang the web process.
    const refused =
      IS_LINUX &&
      Boolean(mediaType) &&
      document.createElement('video').canPlayType(mediaType!) === ''
    if (unplayable || refused) {
      return (
        <Notice action={openAction}>{t('attachmentPreview.unplayable')}</Notice>
      )
    }
    return (
      <div className="flex h-full items-center justify-center bg-black/90 p-4">
        <video
          src={src}
          controls
          autoPlay
          playsInline
          preload="metadata"
          className="max-h-[70vh] max-w-full rounded-md"
          onError={() => setUnplayable(true)}
        />
      </div>
    )
  }
  if (kind === 'audio' && src) {
    // AudioPlayer renders its own decode-failure fallback.
    return (
      <div className="flex items-center justify-center p-6">
        <AudioPlayer
          src={src}
          mediaType={mediaType ?? 'audio/mpeg'}
          filename={source.name}
          className="w-full max-w-md"
        />
      </div>
    )
  }
  if (kind === 'pdf' && src) {
    return (
      <iframe
        src={src}
        title={source.name}
        className="h-full w-full border-0 bg-white"
      />
    )
  }
  if (text !== undefined) {
    if (kind === 'extracted' && !text.trim()) {
      return (
        <Notice action={openAction}>{t('attachmentPreview.noText')}</Notice>
      )
    }
    if (kind === 'html') {
      return <HtmlArtifact code={text} fill />
    }
    const banner =
      kind === 'extracted'
        ? t('attachmentPreview.extracted')
        : truncated
          ? t('attachmentPreview.truncated', {
              size: formatBytes(TEXT_PREVIEW_MAX_BYTES),
            })
          : undefined
    return (
      <div className="flex h-full min-h-0 flex-col">
        {banner && (
          <div className="shrink-0 border-b bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
            {banner}
          </div>
        )}
        {kind === 'markdown' ? (
          <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
            <RenderMarkdown content={text} />
          </div>
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-muted/10 p-5 font-mono text-xs leading-relaxed select-text">
            {text}
          </pre>
        )}
      </div>
    )
  }
  return <Notice action={openAction}>{t('attachmentPreview.failed')}</Notice>
}

type AttachmentPreviewDialogProps = {
  source: AttachmentPreviewSource | null
  onClose: () => void
}

/**
 * Preview of a chat attachment — in the composer or in a sent message — with
 * the file's own app one click away.
 */
export function AttachmentPreviewDialog({
  source,
  onClose,
}: AttachmentPreviewDialogProps) {
  const { t } = useTranslation('chat')
  const serviceHub = useServiceHub()
  const kind = useMemo(
    () =>
      source
        ? classifyAttachmentPreview(
            source.name,
            source.fileType,
            source.mimeType
          )
        : 'unsupported',
    [source]
  )

  const path = source?.path
  const canOpen = Boolean(path) && isPlatformTauri()
  const openFile = () => {
    if (!path) return
    serviceHub
      .opener()
      .openPath(path)
      .catch((error) => console.error('Failed to open attachment:', error))
  }
  const revealFile = () => {
    if (!path) return
    serviceHub
      .opener()
      .revealItemInDir(path)
      .catch((error) => console.error('Failed to reveal attachment:', error))
  }
  const openAction = canOpen ? (
    <Button variant="outline" size="sm" onClick={openFile}>
      <IconExternalLink className="size-4" />
      {t('attachmentPreview.open')}
    </Button>
  ) : undefined

  const ext = source
    ? attachmentPreviewExtension(source.name, source.fileType).toUpperCase()
    : ''
  const meta = [ext, formatBytes(source?.size)].filter(Boolean).join(' · ')

  return (
    <Dialog open={source !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl lg:max-w-4xl xl:max-w-4xl',
          FRAMED_KINDS.has(kind) && 'h-[85vh]'
        )}
      >
        <div className="flex shrink-0 items-center gap-3 border-b py-3 pr-12 pl-5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base" title={source?.name}>
              {source?.name}
            </DialogTitle>
            {meta && (
              <DialogDescription className="truncate text-xs">
                {meta}
              </DialogDescription>
            )}
          </div>
          {canOpen && (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={revealFile}
                aria-label={t('attachmentPreview.showInFolder')}
                title={t('attachmentPreview.showInFolder')}
              >
                <IconFolderOpen className="size-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={openFile}>
                <IconExternalLink className="size-4" />
                {t('attachmentPreview.open')}
              </Button>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {source && (
            <AttachmentPreviewBody
              key={`${source.path ?? source.url ?? ''}:${source.name}`}
              source={source}
              kind={kind}
              openAction={openAction}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
