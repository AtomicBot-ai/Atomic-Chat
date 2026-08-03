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

function normalizeSkillName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
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
    const normalizedName = normalizeSkillName(name).replace(/-+$/, '')
    setSubmitting(true)
    try {
      await onCreate({
        name: normalizedName,
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
              placeholder={t('common:skillNamePlaceholder')}
              disabled={submitting}
              onChange={(event) =>
                setName(normalizeSkillName(event.target.value))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-skill-description">
              {t('common:description')}
            </Label>
            <Textarea
              id="agent-skill-description"
              value={description}
              placeholder={t('common:skillDescriptionPlaceholder')}
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
              placeholder={t('common:skillInstructionsPlaceholder')}
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
              normalizeSkillName(name).replace(/-+$/, '').length < 2 ||
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
