import { useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The provider page's way to TensorRT-LLM models once the engine is installed (spec
 * `tensorrt-llm-desktop`, "Настройки, логи и удаление"; change `add-tensorrt-llm-model-hub`,
 * design D9): models are chosen and downloaded in the Model Hub, which opens on its TensorRT-LLM
 * format. The page keeps the installed models, their removal, the settings and the logs.
 */
export function TensorrtLlmHubLink() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-main-view-fg/10 p-4">
      <p className="min-w-0 text-sm text-main-view-fg/70">{t('providers:tensorrt.hub.body')}</p>
      <Button
        size="sm"
        className="shrink-0"
        onClick={() => navigate({ to: route.hub.index, search: { engine: 'tensorrt-llm' } })}
      >
        {t('providers:tensorrt.hub.action')}
      </Button>
    </div>
  )
}
