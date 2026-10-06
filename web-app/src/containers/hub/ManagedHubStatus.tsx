import { useNavigate } from '@tanstack/react-router'
import { Loader } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { useManagedPlan } from '@/hooks/useManagedPlan'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { hubKey, type ManagedEngine } from '@/lib/managed-engines'
import type { ManagedBlocker } from '@/services/managed-environment/types'

/**
 * What the Model Hub shows under a managed engine's format instead of models (spec
 * `tensorrt-llm-desktop`, "TensorRT-LLM — формат Model Hub по состоянию провайдера"; the same for
 * every managed engine, spec `vllm-desktop`): why the engine cannot be set up here yet, from the
 * core's plan for that engine, or that the core has not answered.
 */

/** Reasons the Hub explains itself, with the numbers the core sends; the rest in the core's words. */
const EXPLAINED: Record<string, { params: string[]; fix: boolean }> = {
  'driver-too-old': { params: ['required', 'actual'], fix: true },
  'compute-capability-too-low': { params: ['required', 'actual'], fix: false },
}

function explained(blocker: ManagedBlocker): { params: Record<string, string>; fix: boolean } | null {
  const known = blocker.reason ? EXPLAINED[blocker.reason] : undefined
  if (!known) return null
  const params = Object.fromEntries(known.params.map((name) => [name, blocker.params?.[name]]))
  if (Object.values(params).some((value) => !value)) return null
  return { params: params as Record<string, string>, fix: known.fix }
}

export function ManagedHubBlocked({
  engine,
  blockers,
}: {
  engine: ManagedEngine
  blockers: ManagedBlocker[]
}) {
  const { t } = useTranslation()
  const k = hubKey(engine)
  const navigate = useNavigate()
  // Shown only once a plan is in: it asks again on request, never on its own.
  const { probing, recheck } = useManagedPlan(engine.id, { enabled: false })

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4 text-sm">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium text-foreground">{t(k('blocked.title'))}</h2>
        <p className="text-muted-foreground">{t(k('blocked.body'))}</p>
      </div>
      <ul className="flex flex-col gap-3">
        {blockers.map((blocker, index) => {
          const own = explained(blocker)
          return (
            <li key={`${blocker.reason ?? blocker.code}-${index}`} className="flex min-w-0 flex-col gap-1">
              {own && (
                <p className="break-words font-medium text-foreground">
                  {t(k(`blocker.${blocker.reason}`), own.params)}
                </p>
              )}
              <p className={own ? 'break-words text-muted-foreground' : 'break-words font-medium text-foreground'}>
                {blocker.message}
              </p>
              {own?.fix && (
                <p className="break-words text-muted-foreground">
                  {t(k(`blocker.${blocker.reason}-fix`))}
                </p>
              )}
              {(blocker.commands ?? []).length > 0 && (
                <pre className="select-all overflow-x-auto rounded bg-muted p-2 text-xs">
                  {blocker.commands!.join('\n')}
                </pre>
              )}
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() =>
            navigate({
              to: route.settings.providers,
              params: { providerName: engine.id },
            })
          }
        >
          {t(k('blocked.openProvider'))}
        </Button>
        <Button size="sm" variant="outline" disabled={probing} onClick={() => void recheck()}>
          {t(k('blocked.checkAgain'))}
        </Button>
      </div>
    </section>
  )
}

/**
 * Before the core's snapshot and plan are in: nothing about the engine is claimed yet. A probe that
 * failed says so and offers to ask again, rather than spinning on.
 */
export function ManagedHubChecking({ engine }: { engine: ManagedEngine }) {
  const { t } = useTranslation()
  const k = hubKey(engine)
  const { probing, error, recheck } = useManagedPlan(engine.id, { enabled: false })
  if (error && !probing) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-sm">
        <p className="break-words text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void recheck()}>
          {t(k('blocked.checkAgain'))}
        </Button>
      </div>
    )
  }
  return (
    <p
      role="status"
      className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"
    >
      <Loader className="size-3 animate-spin" />
      {t(k('checking'))}
    </p>
  )
}
