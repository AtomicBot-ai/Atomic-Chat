import { useNavigate } from '@tanstack/react-router'
import { useMemo, type RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { ManagedModelDownloadAction } from '@/containers/ManagedModelDownloadAction'
import { ManagedInstalledActions } from '@/containers/hub/ManagedInstalledActions'
import { EngineVerdictText } from '@/containers/hub/ManagedVerdicts'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useManagedVerdicts, type EngineVerdict } from '@/hooks/useManagedVerdicts'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { HUB_FORMAT_LABELS } from '@/lib/hub-filters'
import { findInstalledLocalModel } from '@/lib/hub-installed'
import { hubKey, managedEngines } from '@/lib/managed-engines'
import type { ModelFormat } from '@/lib/model-card'
import type { CatalogModel } from '@/services/models/types'

/**
 * The download part of a safetensors card (spec `tensorrt-llm-desktop`, "Выбор и скачивание
 * модели"; spec `vllm-desktop`, "Карточка модели показывает вердикт каждого managed-движка"): every
 * visible managed engine's verdict with its numbers, in registry order — vLLM first — then what the
 * person can do.
 *
 * - "Download" once an installed engine accepts the model: it lands once, in the shared store, and
 *   every installed engine sees it. The download checks again with the first such engine.
 * - "Install <engine>" beside an engine that is not installed and does not refuse the model, leading
 *   to its provider page (design D7: until an engine is installed, models have nowhere to go on
 *   Windows).
 * - "New chat" and delete once downloaded (`ManagedInstalledActions`).
 */
export function ManagedDownloadOptions({
  model,
  sectionRef,
}: {
  model: CatalogModel
  sectionRef?: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const verdicts = useManagedVerdicts(model)
  // Downloaded already: every managed provider lists it under its repository.
  const providers = useModelProvider((store) => store.providers)
  const installed = useMemo(
    () =>
      findInstalledLocalModel(
        providers,
        [model.model_name],
        managedEngines().map((engine) => engine.id)
      ),
    [providers, model.model_name]
  )
  const ready = verdicts.filter((entry) => entry.hub.state === 'ready')
  const downloadVia = ready.find((entry) => entry.verdict?.kind === 'ok')
  // A chat needs an installed engine that does not refuse the model; the delete needs none.
  const chatEngines = ready
    .filter((entry) => entry.verdict?.kind !== 'incompatible')
    .map((entry) => entry.engine)

  return (
    <section ref={sectionRef} className="scroll-mt-4 rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {verdicts.map((entry) => (
            <EngineRow key={entry.engine.id} entry={entry} />
          ))}
        </div>
        {installed ? (
          <ManagedInstalledActions
            modelId={installed.modelId}
            provider={installed.provider}
            engines={chatEngines}
          />
        ) : (
          downloadVia?.verdict?.kind === 'ok' && (
            <ManagedModelDownloadAction
              engineId={downloadVia.engine.id}
              model={model}
              revision={downloadVia.verdict.meta.revision}
            />
          )
        )}
      </div>
    </section>
  )
}

/** One engine: its format badge, its verdict, and its install when it is not installed. */
function EngineRow({ entry }: { entry: EngineVerdict }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { engine, hub, verdict, checking } = entry
  const k = hubKey(engine)
  const offersInstall = hub.state === 'not-installed' && verdict?.kind !== 'incompatible'
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="self-start rounded-[5px] border border-border px-1.5 py-px text-[10px] font-bold tracking-wider text-muted-foreground">
        {HUB_FORMAT_LABELS[engine.id as ModelFormat] ?? engine.label}
      </span>
      {checking ? (
        <p className="text-sm text-muted-foreground">{t(k('models.checking'))}</p>
      ) : (
        verdict && <EngineVerdictText engine={engine} verdict={verdict} />
      )}
      {offersInstall && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() =>
            navigate({ to: route.settings.providers, params: { providerName: engine.id } })
          }
        >
          {t(k('installEngine'))}
        </Button>
      )}
    </div>
  )
}
