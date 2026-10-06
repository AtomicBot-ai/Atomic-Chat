import { useTranslation } from '@/i18n/react-i18next-compat'
import { hubKey, type ManagedEngine } from '@/lib/managed-engines'
import { formatBytes } from '@/lib/utils'
import type { GpuFacts, ModelCompatibility } from '@/services/managed-environment/types'
import type { ManagedVerdict as Verdict } from '@/services/managed-models/verdict'
import { selectEnvironment, useManagedEnvironmentStore } from '@/stores/managed-environment-store'

/**
 * One managed engine's verdict on a model in its Hub card (spec `tensorrt-llm-desktop`, "Выбор и
 * скачивание модели"; spec `vllm-desktop`, "Карточка модели показывает вердикт каждого
 * managed-движка"): it runs here and how big its weights are, or why not — in the core's words,
 * with its numbers and the other cards of this machine it would fit on — or what Hugging Face or
 * the disk refused. Warnings of the check are shown and never stand in the way. Texts are the
 * engine's own (`hub:<engine>.models.*`).
 */

/** One empty list for every render without an environment: a fresh `[]` would re-render forever. */
const NO_GPUS: GpuFacts[] = []

export function EngineVerdictText({ engine, verdict }: { engine: ManagedEngine; verdict: Verdict }) {
  const { t } = useTranslation()
  const k = hubKey(engine)
  const gpus = useManagedEnvironmentStore((state) => selectEnvironment(state)?.gpus ?? NO_GPUS)
  switch (verdict.kind) {
    case 'ok':
      return (
        <div className="flex flex-col gap-1 text-sm">
          <p className="break-words">
            {t(k('models.fits'), { size: formatBytes(verdict.compatibility.weight_bytes) })}
          </p>
          <Warnings compatibility={verdict.compatibility} />
        </div>
      )
    case 'no-space':
      return (
        <p className="break-words text-sm text-destructive">
          {t(k('models.noSpace'), {
            path: verdict.root,
            needed: formatBytes(verdict.neededBytes),
            free: formatBytes(verdict.freeBytes),
          })}
        </p>
      )
    case 'incompatible': {
      const others = verdict.compatibility.fits_other_gpus
        .map((id) => gpus.find((gpu) => gpu.gpu_id === id)?.name ?? id)
        .join(', ')
      return (
        <div className="flex flex-col gap-1 text-sm">
          <p className="break-words text-destructive">
            {verdict.compatibility.verdict.ok ? '' : verdict.compatibility.verdict.error.message}
          </p>
          {others && <p className="break-words">{t(k('models.otherCard'), { cards: others })}</p>}
          <Warnings compatibility={verdict.compatibility} />
        </div>
      )
    }
    case 'gated':
      return (
        <a className="text-sm underline break-words" href={verdict.url} target="_blank" rel="noreferrer">
          {t(k('models.gated'), { url: verdict.url })}
        </a>
      )
    case 'error':
      return <p className="break-words text-sm text-destructive">{verdict.message}</p>
  }
}

/** The check's warnings, in the core's words: shown, never in the way of the download. */
function Warnings({ compatibility }: { compatibility: ModelCompatibility }) {
  const warnings = compatibility.warnings ?? []
  if (warnings.length === 0) return null
  return (
    <ul className="flex flex-col gap-1">
      {warnings.map((warning) => (
        <li key={warning.code} className="break-words text-xs text-amber-600">
          {warning.message}
        </li>
      ))}
    </ul>
  )
}
