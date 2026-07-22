import { useState } from 'react'
import { IconFolderPlus } from '@tabler/icons-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTauriDragDrop } from '@/containers/chatInput/useTauriDragDrop'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

type AgentSkillUploadDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpload: (path: string) => Promise<void>
}

export function AgentSkillUploadDialog({
  open,
  onOpenChange,
  onUpload,
}: AgentSkillUploadDialogProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const upload = async (paths: string[]) => {
    if (paths.length !== 1) {
      toast.error(t('common:uploadOneSkill'))
      return
    }

    setSubmitting(true)
    try {
      await onUpload(paths[0])
      onOpenChange(false)
    } catch (reason) {
      toast.error(String(reason))
    } finally {
      setSubmitting(false)
      setDragging(false)
    }
  }

  const chooseFile = async () => {
    const selected = await serviceHub.dialog().open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: t('common:skillFiles'),
          extensions: ['md', 'zip', 'skill'],
        },
      ],
    })
    if (typeof selected === 'string') {
      await upload([selected])
    }
  }

  useTauriDragDrop({
    enabled: open && !submitting,
    onDragOver: () => setDragging(true),
    onDragLeave: () => setDragging(false),
    onDrop: (paths) => void upload(paths),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) {
          setDragging(false)
          onOpenChange(nextOpen)
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('common:uploadSkill')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('common:uploadSkillDescription')}
          </DialogDescription>
        </DialogHeader>
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          className={cn(
            'h-56 w-full flex-col gap-5 rounded-lg border border-dashed text-muted-foreground',
            dragging && 'border-primary bg-accent text-foreground'
          )}
          onClick={() => void chooseFile()}
          onDragEnter={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
          }}
        >
          <IconFolderPlus className="size-10 stroke-1" />
          <span className="text-base">
            {submitting
              ? t('common:uploadingSkill')
              : t('common:dropSkillToUpload')}
          </span>
        </Button>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{t('common:skillFileRequirements')}</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t('common:skillMarkdownRequirement')}</li>
            <li>{t('common:skillArchiveRequirement')}</li>
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  )
}
