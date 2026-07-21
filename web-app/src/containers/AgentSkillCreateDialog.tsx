import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { CreateAgentSkillRequest } from '@/services/agent/skills'

type AgentSkillCreateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (request: CreateAgentSkillRequest) => Promise<void>
}

export function AgentSkillCreateDialog({
  open,
  onOpenChange,
  onCreate,
}: AgentSkillCreateDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) {
      setName('')
      setDescription('')
      setInstructions('')
      setSubmitting(false)
    }
  }, [open])

  const submit = async () => {
    setSubmitting(true)
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      })
      onOpenChange(false)
    } catch (reason) {
      toast.error(String(reason))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('common:writeSkillInstructions')}</DialogTitle>
          <DialogDescription>
            {t('common:createSkillDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <Label htmlFor="agent-skill-name">{t('common:skillName')}</Label>
            <Input
              id="agent-skill-name"
              value={name}
              placeholder="weekly-status-report"
              disabled={submitting}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-skill-description">
              {t('common:description')}
            </Label>
            <Textarea
              id="agent-skill-description"
              value={description}
              className="min-h-24 resize-none"
              disabled={submitting}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-skill-instructions">
              {t('common:instructions')}
            </Label>
            <Textarea
              id="agent-skill-instructions"
              value={instructions}
              className="min-h-64 resize-y"
              disabled={submitting}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('common:cancel')}
          </Button>
          <Button
            disabled={
              submitting ||
              !name.trim() ||
              !description.trim() ||
              !instructions.trim()
            }
            onClick={() => void submit()}
          >
            {t('common:create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
