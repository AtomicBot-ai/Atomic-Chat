/**
 * The way out when the TensorRT-LLM setup is stuck, on the provider page (2026-10-06: a Windows on
 * Arm machine stayed blocked after conf had published the fix, and neither reinstalling the app nor
 * "Try again" changed anything — its state lives outside the app, and only photos of PowerShell
 * explained it):
 *
 * - a notice when the core reads conf, or keeps its state, somewhere else because an environment
 *   variable says so — the cause that hid the fix there;
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
import { useTensorrtPlan } from '@/hooks/useTensorrtPlan'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { copyToClipboard } from '@/lib/clipboard'
import {
  environmentDiagnostics,
  readManagedSnapshot,
  resetEnvironment,
} from '@/services/managed-environment/client'
import {
  selectEnvironment,
  selectFailedSetup,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

const errorText = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error)

export function TensorrtLlmTroubleshooting() {
  const { t } = useTranslation()
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const failed = useManagedEnvironmentStore(selectFailedSetup)
  const applySnapshot = useManagedEnvironmentStore(
    (state) => state.applySnapshot
  )
  // Only its `recheck`: the setup panel owns the probing; this asks it again after a reset.
  const { recheck } = useTensorrtPlan({ enabled: false })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!environment) return null
  const environmentId = environment.environment_id
  const overrides = environment.source_overrides ?? []
  const running = environment.active_operation_id !== null

  const copyDiagnostics = async () => {
    setBusy(true)
    try {
      const report = await environmentDiagnostics(environmentId)
      const copied = await copyToClipboard(JSON.stringify(report, null, 2))
      if (copied) toast.success(t('providers:tensorrt.troubleshooting.copied'))
      else toast.error(t('providers:tensorrt.troubleshooting.copyFailed'))
    } catch (error) {
      toast.error(
        t('providers:tensorrt.troubleshooting.unavailable', {
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
        t('providers:tensorrt.troubleshooting.resetDone', {
          count: result.archived_operation_ids.length,
        })
      )
    } catch (error) {
      toast.error(
        t('providers:tensorrt.troubleshooting.resetFailed', {
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
          {t('providers:tensorrt.troubleshooting.title')}
        </h3>
        <p className="text-sm text-main-view-fg/70">
          {t('providers:tensorrt.troubleshooting.description')}
        </p>
      </div>

      {overrides.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md bg-yellow-500/10 p-3">
          <p className="text-sm font-medium">
            {t('providers:tensorrt.troubleshooting.overridesTitle')}
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
            {t('providers:tensorrt.troubleshooting.overridesHint')}
          </p>
        </div>
      )}

      {failed && (
        <p className="text-sm text-main-view-fg/70">
          {t('providers:tensorrt.troubleshooting.afterFailure')}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void copyDiagnostics()}
        >
          {t('providers:tensorrt.troubleshooting.copy')}
        </Button>
        <Button
          variant={failed ? 'default' : 'outline'}
          size="sm"
          disabled={busy || running}
          onClick={() => setConfirmOpen(true)}
        >
          {failed
            ? t('providers:tensorrt.troubleshooting.startOver')
            : t('providers:tensorrt.troubleshooting.reset')}
        </Button>
      </div>
      {running && (
        <p className="text-xs text-main-view-fg/60">
          {t('providers:tensorrt.troubleshooting.running')}
        </p>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('providers:tensorrt.troubleshooting.confirmTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('providers:tensorrt.troubleshooting.confirmBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t('providers:tensorrt.troubleshooting.cancel')}
            </Button>
            <Button onClick={() => void reset()}>
              {t('providers:tensorrt.troubleshooting.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
