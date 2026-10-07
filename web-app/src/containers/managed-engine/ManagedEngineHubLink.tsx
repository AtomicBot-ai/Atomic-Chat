import { useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { providerKey, type ManagedEngine } from '@/lib/managed-engines'
import type { ModelFormat } from '@/lib/model-card'

/**
 * A managed engine's provider page's way to its models once the engine is installed (spec
 * `tensorrt-llm-desktop`, "Настройки, логи и удаление"; change `add-tensorrt-llm-model-hub`,
 * design D9): models are chosen and downloaded in the Model Hub, which opens on the engine's format.
 * The page keeps the installed models, their removal, the settings and the logs.
 */
export function ManagedEngineHubLink({ engine }: { engine: ManagedEngine }) {
  const { t } = useTranslation()
  const k = providerKey(engine)
  const navigate = useNavigate()
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-main-view-fg/10 p-4">
      <p className="min-w-0 text-sm text-main-view-fg/70">{t(k('hub.body'))}</p>
      <Button
        size="sm"
        className="shrink-0"
        onClick={() => navigate({ to: route.hub.index, search: { engine: engine.id as ModelFormat } })}
      >
        {t(k('hub.action'))}
      </Button>
    </div>
  )
}
