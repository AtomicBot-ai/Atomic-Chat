import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useAssistant } from '@/hooks/useAssistant'
import { AvatarEmoji } from '@/containers/AvatarEmoji'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ChevronDown, Plus } from 'lucide-react'
import AddEditAssistant from './AddEditAssistant'
import { SecureEnvironmentFields } from './SecureEnvironmentFields'
import {
  ensureChatExecStatus,
  useChatExecStatus,
} from '@/hooks/useChatExecStatus'
import {
  ensureSecureEnvironmentsLoaded,
  saveSecureEnvironment,
  secureEnvironmentAvailability,
  useSecureEnvironments,
} from '@/hooks/useSecureEnvironments'
import type { SecureEnvironment } from '@/services/chat-exec/types'

interface AddProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingKey: string | null
  initialData?: {
    id: string
    name: string
    updated_at: number
    assistantId?: string
  }
  /** Creating: resolves to the new project's id, so its secure environment can be saved. */
  onSave: (name: string, assistantId?: string) => void | Promise<string | void>
}

const sameEnvironment = (
  a: SecureEnvironment | null,
  b: SecureEnvironment | null
) => JSON.stringify(a) === JSON.stringify(b)

export default function AddProjectDialog({
  open,
  onOpenChange,
  editingKey,
  initialData,
  onSave,
}: AddProjectDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(initialData?.name || '')
  const [selectedAssistantId, setSelectedAssistantId] = useState<string | undefined>(initialData?.assistantId)
  const { folders } = useThreadManagement()
  const { assistants, addAssistant, defaultAssistantId } = useAssistant()
  const [addAssistantDialogOpen, setAddAssistantDialogOpen] = useState(false)
  const chatExecStatus = useChatExecStatus((state) => state.status)
  const savedEnvironment = useSecureEnvironments((state) =>
    editingKey ? (state.environments[editingKey] ?? null) : null
  )
  const [secureEnvironment, setSecureEnvironment] =
    useState<SecureEnvironment | null>(savedEnvironment)
  const [saving, setSaving] = useState(false)

  const selectedAssistant = assistants.find((a) => a.id === selectedAssistantId)

  useEffect(() => {
    if (open) {
      setName(initialData?.name || '')
      // A new project starts with the default assistant (Settings); editing
      // keeps the project's own choice, "No assistant" included.
      setSelectedAssistantId(
        editingKey
          ? initialData?.assistantId
          : assistants.some((assistant) => assistant.id === defaultAssistantId)
            ? defaultAssistantId
            : undefined
      )
      void ensureSecureEnvironmentsLoaded()
      void ensureChatExecStatus()
    }
    // Only on open: re-running on an `assistants` change would throw away the
    // assistant the user just created from inside this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialData])

  useEffect(() => {
    if (open) setSecureEnvironment(savedEnvironment)
  }, [open, savedEnvironment])

  const handleSave = async () => {
    if (!name.trim() || saving) return

    const trimmedName = name.trim()

    // Check for duplicate names (excluding current project when editing)
    const isDuplicate = folders.some(
      (folder) =>
        folder.name.toLowerCase() === trimmedName.toLowerCase() &&
        folder.id !== editingKey
    )

    if (isDuplicate) {
      toast.warning(t('projects.addProjectDialog.alreadyExists', { projectName: trimmedName }))
      return
    }

    const environmentChanged = !sameEnvironment(
      secureEnvironment,
      savedEnvironment
    )
    setSaving(true)
    try {
      // Editing: the policy is saved first, so a folder the backend refuses
      // keeps the dialog open with nothing changed.
      if (editingKey && environmentChanged) {
        await saveSecureEnvironment(editingKey, secureEnvironment)
      }
    } catch (error) {
      toast.error(
        t('projects.secureEnvironment.saveError', { error: String(error) })
      )
      setSaving(false)
      return
    }
    const projectId = await onSave(trimmedName, selectedAssistantId)
    if (!editingKey && secureEnvironment && typeof projectId === 'string') {
      try {
        await saveSecureEnvironment(projectId, secureEnvironment)
      } catch (error) {
        toast.error(
          t('projects.secureEnvironment.createdWithoutIt', {
            projectName: trimmedName,
            error: String(error),
          })
        )
      }
    }
    setSaving(false)

    // Show success message
    if (editingKey) {
      toast.success(t('projects.addProjectDialog.updateSuccess', { projectName: trimmedName }))
    } else {
      toast.success(t('projects.addProjectDialog.createSuccess', { projectName: trimmedName }))
    }
    setName('')
    setSelectedAssistantId(undefined)
    setSecureEnvironment(null)
  }

  const handleCancel = () => {
    onOpenChange(false)
    setName('')
    setSelectedAssistantId(undefined)
  }

  // Check if the button should be disabled
  const hasChanged = editingKey
    ? name.trim() !== initialData?.name ||
      selectedAssistantId !== initialData?.assistantId ||
      !sameEnvironment(secureEnvironment, savedEnvironment)
    : true
  const isButtonDisabled = !name.trim() || saving || (editingKey && !hasChanged)

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editingKey ? t('projects.addProjectDialog.editTitle') : t('projects.addProjectDialog.createTitle')}
          </DialogTitle>
        </DialogHeader>
        {/* min-w-0: a grid item otherwise widens its column to its longest
            unbreakable text (a project folder's path), pushing the dialog
            past its edge instead of letting the path truncate. */}
        <div className="min-w-0 space-y-5 py-1">
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              {t('projects.addProjectDialog.nameLabel')}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('projects.addProjectDialog.namePlaceholder')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isButtonDisabled) {
                  void handleSave()
                }
              }}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              {t('projects.addProjectDialog.assistant')}
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-between rounded-md"
                >
                  {selectedAssistant ? (
                    <div className="flex items-center gap-2">
                      {selectedAssistant.avatar && (
                        <AvatarEmoji
                          avatar={selectedAssistant.avatar}
                          imageClassName="w-4 h-4 object-contain"
                          textClassName="text-sm"
                        />
                      )}
                      <span>{selectedAssistant.name}</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('projects.addProjectDialog.selectAssistant')}
                    </span>
                  )}
                  <ChevronDown className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
                <DropdownMenuItem
                  onSelect={() => setSelectedAssistantId(undefined)}
                >
                  <span className="text-muted-foreground">
                    {t('projects.addProjectDialog.noAssistant')}
                  </span>
                </DropdownMenuItem>
                {assistants.map((assistant) => (
                  <DropdownMenuItem
                    key={assistant.id}
                    onSelect={() => setSelectedAssistantId(assistant.id)}
                  >
                    <div className="flex items-center gap-2">
                      {assistant.avatar && (
                        <AvatarEmoji
                          avatar={assistant.avatar}
                          imageClassName="w-4 h-4 object-contain"
                          textClassName="text-sm"
                        />
                      )}
                      <span>{assistant.name}</span>
                    </div>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setAddAssistantDialogOpen(true)}
                >
                  <div className="flex items-center gap-2">
                    <Plus className="size-4" />
                    <span>{t('projects.addProjectDialog.addAssistant')}</span>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <SecureEnvironmentFields
            value={secureEnvironment}
            onChange={setSecureEnvironment}
            availability={secureEnvironmentAvailability(chatExecStatus)}
          />
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={handleCancel}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={Boolean(isButtonDisabled)}>
            {editingKey ? t('projects.addProjectDialog.updateButton') : t('projects.addProjectDialog.createButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AddEditAssistant
      open={addAssistantDialogOpen}
      onOpenChange={setAddAssistantDialogOpen}
      editingKey={null}
      onSave={(assistant) => {
        addAssistant(assistant)
        setSelectedAssistantId(assistant.id)
      }}
    />
  </>
  )
}
