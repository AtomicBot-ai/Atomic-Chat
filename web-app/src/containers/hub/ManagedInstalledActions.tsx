import { useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { DeleteModelAction } from '@/containers/hub/DeleteModelAction'
import { DropdownControl } from '@/containers/dynamicControllerSetting/DropdownControl'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ManagedEngine } from '@/lib/managed-engines'
import { switchToModel } from '@/utils/switchModel'

/**
 * A downloaded model of the shared store in its Hub card (spec `tensorrt-llm-desktop`, "Скачанные
 * модели TensorRT-LLM в Model Hub"; spec `vllm-desktop`, "Скачанная модель доступна всем
 * установленным движкам"): "New chat" on a managed provider, as the MLX card opens one on `mlx`,
 * and delete — through the core, which stops the model in whichever engine holds it, deletes its
 * folder and every engine's caches, and says how much that freed.
 *
 * "New chat" goes straight to the one installed engine that takes the model; with several it lets
 * the person choose, the first in registry order (vLLM) chosen. A chat needs an engine; the delete
 * does not.
 */
export function ManagedInstalledActions({
  modelId,
  provider,
  engines,
}: {
  /** The id the providers list the model under: its repository. */
  modelId: string
  /** A managed provider that lists it; the delete goes to the shared store through it. */
  provider: string
  /** Installed engines that do not refuse the model, in registry order. */
  engines: readonly ManagedEngine[]
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const [picked, setPicked] = useState<string | null>(null)
  const engine = engines.find((entry) => entry.id === picked) ?? engines[0]

  const newChat = useCallback(() => {
    if (!engine) return
    useModelProvider.getState().selectModelProvider(engine.id, modelId)
    switchToModel({ modelId, providerName: engine.id, serviceHub }).catch((error) => {
      console.error('[ManagedInstalledActions] switchToModel failed:', error)
    })
    navigate({
      to: route.home,
      params: {},
      search: { threadModel: { id: modelId, provider: engine.id } },
    })
  }, [engine, modelId, navigate, serviceHub])

  return (
    <div className="flex shrink-0 items-center gap-1">
      {engines.length > 1 && engine && (
        <div className="w-36" aria-label={t('hub:managedEngineChoice')}>
          <DropdownControl
            value={engine.id}
            options={engines.map((entry) => ({ value: entry.id, name: entry.label }))}
            onChange={(value) => setPicked(String(value))}
          />
        </div>
      )}
      {engine && (
        <Button size="sm" onClick={newChat}>
          {t('hub:newChat')}
        </Button>
      )}
      <DeleteModelAction modelId={modelId} provider={provider} />
    </div>
  )
}
