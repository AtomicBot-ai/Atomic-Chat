import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { DeleteModelAction } from '@/containers/hub/DeleteModelAction'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { TENSORRT_LLM_PROVIDER } from '@/lib/hub-installed'
import { switchToModel } from '@/utils/switchModel'

/**
 * A downloaded TensorRT-LLM model in its Hub card (spec `tensorrt-llm-desktop`, "Скачанные модели
 * TensorRT-LLM в Model Hub"; design D8): "New chat" on the TensorRT-LLM provider, as the MLX card
 * opens one on `mlx`, and delete — through the core, which stops the model, deletes its folder and
 * engine caches, and says how much that freed. A chat needs the engine; the delete does not.
 */
export function TensorrtInstalledActions({
  modelId,
  engineReady,
}: {
  /** The id the extension lists the model under: its repository. */
  modelId: string
  engineReady: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()

  const newChat = useCallback(() => {
    useModelProvider.getState().selectModelProvider(TENSORRT_LLM_PROVIDER, modelId)
    switchToModel({ modelId, providerName: TENSORRT_LLM_PROVIDER, serviceHub }).catch((error) => {
      console.error('[TensorrtInstalledActions] switchToModel failed:', error)
    })
    navigate({
      to: route.home,
      params: {},
      search: { threadModel: { id: modelId, provider: TENSORRT_LLM_PROVIDER } },
    })
  }, [modelId, navigate, serviceHub])

  return (
    <div className="flex shrink-0 items-center gap-1">
      {engineReady && (
        <Button size="sm" onClick={newChat}>
          {t('hub:newChat')}
        </Button>
      )}
      <DeleteModelAction modelId={modelId} provider={TENSORRT_LLM_PROVIDER} />
    </div>
  )
}
