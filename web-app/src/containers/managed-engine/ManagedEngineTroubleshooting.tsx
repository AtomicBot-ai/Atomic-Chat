/**
 * The way out when a managed engine's setup is stuck, on its provider page (2026-10-06: a Windows on
 * Arm machine stayed blocked after conf had published the fix, and neither reinstalling the app nor
 * "Try again" changed anything — its state lives outside the app, and only photos of PowerShell
 * explained it):
 *
 * - a notice when the core reads this engine's conf, or keeps its state, somewhere else because an
 *   environment variable says so — the cause that hid the fix there;
 * - "Copy diagnostics": the core's own report (where each conf document comes from, what is cached,
 *   every operation on disk, recent warnings) as JSON on the clipboard, for a support message;
 * - "Reset setup state": the core archives every finished operation, so a failed setup is no longer
 *   shown or resumed and the next one starts from a fresh plan. After a failed setup this is the
 *   "start over"; nothing installed — the WSL distribution, images, models — is touched.
 *
 * An older core has neither route: the buttons then say the core is too old instead of failing
 * silently.
 */

import { useState } from 'react'
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
import { useManagedPlan } from '@/hooks/useManagedPlan'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  providerKey,
  TENSORRT_LLM_ENGINE,
  type ManagedEngine,
} from '@/lib/managed-engines'
import { copyToClipboard } from '@/lib/clipboard'
import {
  environmentDiagnostics,
  readManagedSnapshot,
  resetEnvironment,
} from '@/services/managed-environment/client'
import type { EnvironmentSourceOverride } from '@/services/managed-environment/types'
import {
  selectEnvironment,
  selectFailedSetup,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

const DESCRIPTOR_URL_VARIABLE = 'ATOMIC_RUNTIME_DESCRIPTOR_URL'

/**
 * The overrides that move what `engineId` reads. The core lists them once per host
 * (`EnvironmentSnapshot.source_overrides`), but a descriptor override belongs to one engine:
 * `ATOMIC_RUNTIME_DESCRIPTOR_URL_<ENGINE>` (the id upper-cased, `-` as `_`) to that engine, the
 * older `ATOMIC_RUNTIME_DESCRIPTOR_URL` to TensorRT-LLM alone. Every other variable — the
 * environment manifest, the managed-runtime state folder — moves all engines. Without this, the
 * vLLM page listed the TensorRT-LLM descriptor under "reads vLLM settings", and the other way round.
 */
function overridesAffecting(
  engineId: string,
  overrides: readonly EnvironmentSourceOverride[]
): EnvironmentSourceOverride[] {
  const own = `${DESCRIPTOR_URL_VARIABLE}_${engineId.toUpperCase().replace(/-/g, '_')}`
  return overrides.filter(({ variable }) => {
    if (variable === DESCRIPTOR_URL_VARIABLE) return engineId === TENSORRT_LLM_ENGINE.id
    if (variable.startsWith(`${DESCRIPTOR_URL_VARIABLE}_`)) return variable === own
    return true
  })
}

const errorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error)

export function ManagedEngineTroubleshooting({ engine }: { engine: ManagedEngine }) {
  const { t } = useTranslation()
  const k = providerKey(engine)
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const failed = useManagedEnvironmentStore((state) => selectFailedSetup(state, engine.id))
  const applySnapshot = useManagedEnvironmentStore(
    (state) => state.applySnapshot
  )
  // Only its `recheck`: the setup panel owns the probing; this asks it again after a reset.
  const { recheck } = useManagedPlan(engine.id, { enabled: false })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!environment) return null
  const environmentId = environment.environment_id
  const overrides = overridesAffecting(engine.id, environment.source_overrides ?? [])
  const running = environment.active_operation_id !== null

  const copyDiagnostics = async () => {
    setBusy(true)
    try {
      const report = await environmentDiagnostics(environmentId)
      const copied = await copyToClipboard(JSON.stringify(report, null, 2))
      if (copied) toast.success(t(k('troubleshooting.copied')))
      else toast.error(t(k('troubleshooting.copyFailed')))
    } catch (error) {
      toast.error(
        t(k('troubleshooting.unavailable'), {
          reason: errorText(error),
        })
      )
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setConfirmOpen(false)
    setBusy(true)
    try {
      const result = await resetEnvironment(environmentId)
      // The core forgot the archived operations; take its snapshot again so this page does too, and
      // probe afresh: the plan key does not change with a reset, so nothing else would ask again.
      applySnapshot(await readManagedSnapshot())
      void recheck()
      toast.success(
        t(k('troubleshooting.resetDone'), {
          count: result.archived_operation_ids.length,
        })
      )
    } catch (error) {
      toast.error(
        t(k('troubleshooting.resetFailed'), {
          reason: errorText(error),
        })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-main-view-fg/10 p-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-main-view-fg">
          {t(k('troubleshooting.title'))}
        </h3>
        <p className="text-sm text-main-view-fg/70">
          {t(k('troubleshooting.description'))}
        </p>
      </div>

      {overrides.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md bg-yellow-500/10 p-3">
          <p className="text-sm font-medium">
            {t(k('troubleshooting.overridesTitle'))}
          </p>
          <ul className="flex flex-col gap-1">
            {overrides.map((override) => (
              <li
                key={override.variable}
                className="text-xs break-all font-mono"
              >
                {override.variable}={override.value}
              </li>
            ))}
          </ul>
          <p className="text-sm text-main-view-fg/70">
            {t(k('troubleshooting.overridesHint'))}
          </p>
        </div>
      )}

      {failed && (
        <p className="text-sm text-main-view-fg/70">
          {t(k('troubleshooting.afterFailure'))}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void copyDiagnostics()}
        >
          {t(k('troubleshooting.copy'))}
        </Button>
        <Button
          variant={failed ? 'default' : 'outline'}
          size="sm"
          disabled={busy || running}
          onClick={() => setConfirmOpen(true)}
        >
          {failed
            ? t(k('troubleshooting.startOver'))
            : t(k('troubleshooting.reset'))}
        </Button>
      </div>
      {running && (
        <p className="text-xs text-main-view-fg/60">
          {t(k('troubleshooting.running'))}
        </p>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(k('troubleshooting.confirmTitle'))}
            </DialogTitle>
            <DialogDescription>
              {t(k('troubleshooting.confirmBody'))}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t(k('troubleshooting.cancel'))}
            </Button>
            <Button onClick={() => void reset()}>
              {t(k('troubleshooting.confirm'))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
