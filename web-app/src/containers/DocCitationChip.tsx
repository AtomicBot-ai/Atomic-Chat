import { useEffect, useState } from 'react'
import { ExtensionTypeEnum, type VectorDBExtension } from '@janhq/core'
import { IconFileText } from '@tabler/icons-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { DocCitation } from '@/lib/doc-citations'
import { ExtensionManager } from '@/lib/extension'
import { isPlatformTauri } from '@/lib/platform/utils'

type LiveSource =
  | { status: 'unchecked' }
  | { status: 'listed'; name?: string; path?: string; passages: number }
  | { status: 'removed' }

/**
 * The cited file as its collection lists it now, so a document removed after
 * the answer was written reads as removed, and an answer from before readable
 * labels learns the file name. Outputs that do not name their collection
 * (Agent turns) keep what the tool stored.
 */
async function readLiveSource(citation: DocCitation): Promise<LiveSource> {
  try {
    const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
      ExtensionTypeEnum.VectorDB
    )
    let files
    if (citation.projectId && ext?.listAttachmentsForProject) {
      files = await ext.listAttachmentsForProject(citation.projectId)
    } else if (citation.threadId && ext?.listAttachments) {
      files = await ext.listAttachments(citation.threadId)
    } else {
      return { status: 'unchecked' }
    }
    const file = files.find((candidate) => candidate.id === citation.fileId)
    return file
      ? {
          status: 'listed',
          name: file.name,
          path: file.path,
          passages: file.chunk_count,
        }
      : { status: 'removed' }
  } catch (error) {
    console.warn('Could not check the cited document:', error)
    return { status: 'unchecked' }
  }
}

export function DocCitationChip({ citation }: { citation: DocCitation }) {
  const { t } = useTranslation('chat')
  const serviceHub = useServiceHub()
  const [open, setOpen] = useState(false)
  const [live, setLive] = useState<LiveSource>({ status: 'unchecked' })

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void readLiveSource(citation).then((next) => {
      if (!cancelled && next.status !== 'unchecked') setLive(next)
    })
    return () => {
      cancelled = true
    }
  }, [open, citation])

  const listed = live.status === 'listed' ? live : undefined
  const removed = citation.removed || live.status === 'removed'
  const name =
    listed?.name ||
    (citation.removed
      ? t('docCitation.removedDocument')
      : (citation.source ?? t('docCitation.document')))
  const path = listed?.path ?? citation.path
  const total = listed?.passages ?? citation.passages
  const canOpen = !removed && Boolean(path) && isPlatformTauri()

  const openWith = (action: 'openPath' | 'revealItemInDir') => {
    if (!path) return
    const opener = serviceHub.opener()
    void opener[action](path).catch((error) => {
      console.error('Failed to open the cited document:', error)
      toast.error(t('docCitation.openFailed', { name }), {
        description: t('docCitation.openFailedDescription'),
      })
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="doc-citation-chip"
          aria-label={t('docCitation.chipLabel', {
            name,
            passage: citation.passage,
          })}
          className="mx-0.5 inline-flex max-w-64 items-center gap-1 rounded-md border border-border bg-secondary px-1.5 py-px align-baseline text-xs font-medium text-foreground hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconFileText size={12} className="shrink-0 text-muted-foreground" />
          <span className={removed ? 'truncate line-through' : 'truncate'}>
            {name}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            §{citation.passage}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] space-y-2 p-3"
        data-testid="doc-citation-card"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {total
              ? t('docCitation.passageOf', {
                  passage: citation.passage,
                  total,
                })
              : t('docCitation.passage', { passage: citation.passage })}
          </p>
        </div>
        {removed && (
          <p role="status" className="text-xs text-destructive">
            {t(
              citation.scope === 'thread'
                ? 'docCitation.removedFromChat'
                : 'docCitation.removedFromProject'
            )}
          </p>
        )}
        {citation.text && (
          <blockquote className="max-h-48 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-md border-l-2 border-border bg-muted/50 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground">
            {citation.text}
          </blockquote>
        )}
        {canOpen && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openWith('openPath')}
            >
              {t('docCitation.open')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openWith('revealItemInDir')}
            >
              {t('docCitation.showInFolder')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
