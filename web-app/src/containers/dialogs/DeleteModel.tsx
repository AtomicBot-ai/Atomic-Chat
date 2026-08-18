import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useServiceHub } from '@/hooks/useServiceHub'
import { deleteLocalModel } from '@/lib/model-deletion'

import { IconTrash } from '@tabler/icons-react'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'

type DialogDeleteModelProps = {
  provider: ModelProvider
  modelId?: string
}

export const DialogDeleteModel = ({
  provider,
  modelId,
}: DialogDeleteModelProps) => {
  const { t } = useTranslation()
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const serviceHub = useServiceHub()

  const removeModel = async () => {
    try {
      await deleteLocalModel(serviceHub, selectedModelId, provider.provider)
      toast.success(
        t('providers:deleteModel.title', { modelId: selectedModelId }),
        {
          id: `delete-model-${selectedModelId}`,
          description: t('providers:deleteModel.success', {
            modelId: selectedModelId,
          }),
        }
      )
    } catch (error) {
      // Previously this rejection was dropped on the floor while the model had
      // already been removed from the cache: the row vanished, the weights
      // stayed, and it reappeared on the next provider refresh.
      console.error('[DialogDeleteModel] deleteModel failed:', error)
      toast.error(
        t('providers:deleteModel.title', { modelId: selectedModelId }),
        {
          id: `delete-model-${selectedModelId}`,
          description: error instanceof Error ? error.message : String(error),
        }
      )
    }
  }

  // Initialize with the provided model ID or the first model if available
  useEffect(() => {
    if (modelId) {
      setSelectedModelId(modelId)
    } else if (provider.models && provider.models.length > 0) {
      setSelectedModelId(provider.models[0].id)
    }
  }, [provider, modelId])

  // Get the currently selected model
  const selectedModel = provider.models.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m: any) => m.id === selectedModelId
  )

  if (!selectedModel) {
    return null
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <div
          className="size-6 cursor-pointer flex items-center justify-center rounded transition-all duration-200 ease-in-out"
          title={t('providers:deleteModel.delete')}
          aria-label={t('providers:deleteModel.delete')}
        >
          <IconTrash size={18} className="text-muted-foreground" />
        </div>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('providers:deleteModel.title', { modelId: selectedModel.id })}
          </DialogTitle>
          <DialogDescription>
            {t('providers:deleteModel.description')}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="mt-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              {t('providers:deleteModel.cancel')}
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button
              variant="destructive"
              size="sm"
              onClick={removeModel}
              autoFocus
            >
              {t('providers:deleteModel.delete')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
