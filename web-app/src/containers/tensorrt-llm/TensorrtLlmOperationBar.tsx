import { useState } from 'react'
import { IconLoader2, IconRefresh, IconX } from '@tabler/icons-react'
import { invoke } from '@tauri-apps/api/core'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { stepOf } from '@/lib/tensorrt-llm/setup-view'
import { cn, formatBytes } from '@/lib/utils'
import type { EnvironmentOperation } from '@/services/managed-environment/types'
import { useRunningHostSteps } from '@/stores/host-step-running-store'
import {
  selectEnvironment,
  selectSetupOperation,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * A TensorRT-LLM setup or removal in progress, as one of the app's notification cards (the same
 * place and look as the update banners: bottom right, above the download panel): the phase in
 * words, the bytes while the image downloads, and — only when the step needs it — the one action
 * left to the person: restart Windows after WSL was turned on, or sign out on Linux after the
 * `docker` group was added (Rust `atomic_core_finish_session_step`). After the UAC approval Windows
 * installs WSL for minutes with no window, so the card says that instead of asking for approval.
 */
export function TensorrtLlmOperationBar() {
  const operation = useManagedEnvironmentStore(selectSetupOperation)
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const runningSteps = useRunningHostSteps((state) => state.steps)
  const windows = environment?.executor === 'wsl-docker'
  // "Later" / close hides the card for this step only: the next phase brings it back.
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!operation) return null
  const key = `${operation.operation_id}:${operation.phase}`
  if (dismissed === key) return null
  const running =
    operation.pending_host_step !== null &&
    runningSteps.includes(operation.pending_host_step.step_id)
  return (
    <OperationBarView
      operation={operation}
      windows={windows}
      hostStepRunning={running}
      onDismiss={() => setDismissed(key)}
    />
  )
}

export function OperationBarView({
  operation,
  windows,
  hostStepRunning = false,
  onDismiss,
}: {
  operation: EnvironmentOperation
  windows: boolean
  /** The privileged step was approved and is running (`managed-host-step-running`). */
  hostStepRunning?: boolean
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const step = stepOf(operation)

  const text =
    step === 'host-step'
      ? hostStepRunning
        ? t(windows ? 'providers:tensorrt.hostStep.uac.running' : 'providers:tensorrt.hostStep.running')
        : t(windows ? 'providers:tensorrt.bar.hostStepWindows' : 'providers:tensorrt.bar.hostStep')
      : step === 'reboot'
        ? t('providers:tensorrt.bar.reboot')
        : step === 'relogin'
          ? t('providers:tensorrt.bar.relogin')
          : operation.target.kind === 'environment' && operation.phase === 'removing'
            ? t('providers:tensorrt.removeEnvironment.removing')
            : windows &&
                (operation.phase === 'preparing-host' ||
                  operation.phase === 'preparing-environment')
              ? t(`providers:tensorrt.phaseWindows.${operation.phase}`)
              : t(`providers:tensorrt.phase.${operation.phase}`)

  const progress = operation.progress
  const bytes =
    progress?.unit === 'bytes' && progress.completed !== null && progress.total
      ? { completed: progress.completed, total: progress.total }
      : null

  const action: { name: 'restart' | 'sign-out'; label: string } | null =
    step === 'reboot' && windows
      ? { name: 'restart', label: t('providers:tensorrt.bar.restartNow') }
      : step === 'relogin' && !windows
        ? { name: 'sign-out', label: t('providers:tensorrt.bar.signOutNow') }
        : null

  const run = async (name: 'restart' | 'sign-out') => {
    setBusy(true)
    setError(null)
    try {
      await invoke('atomic_core_finish_session_step', { action: name })
    } catch (e) {
      setError(
        t('providers:tensorrt.bar.actionFailed', {
          error: e instanceof Error ? e.message : String(e),
        })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="tensorrt-operation-bar"
      className={cn(
        'fixed z-40 bottom-[calc(1rem+var(--download-panel-offset,0px))] right-2 w-[min(24rem,calc(100vw-1rem))]',
        'transition-[bottom] duration-200',
        'rounded-xl border bg-background shadow-md'
      )}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('providers:tensorrt.bar.later')}
        onClick={onDismiss}
        className="absolute right-1.5 top-1.5 text-muted-foreground"
      >
        <IconX size={14} />
      </Button>

      <div className="flex items-start gap-2.5 px-4 pt-4 pr-9">
        {action ? (
          <IconRefresh size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
        ) : (
          <IconLoader2 size={18} className="mt-0.5 shrink-0 animate-spin text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-5">TensorRT-LLM</div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground break-words">{text}</div>
        </div>
      </div>

      {bytes ? (
        <div className="flex flex-col gap-1 px-4 pt-3">
          <Progress value={(bytes.completed / bytes.total) * 100} />
          <div className="text-[11px] leading-4 tabular-nums text-muted-foreground">
            {formatBytes(bytes.completed)} / {formatBytes(bytes.total)}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="px-4 pt-2 text-[11px] leading-4 text-destructive break-words">{error}</div>
      ) : null}

      {action ? (
        <div className="flex flex-wrap items-center justify-end gap-1 px-2 pb-2 pt-3">
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('providers:tensorrt.bar.later')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void run(action.name)}>
            {action.label}
          </Button>
        </div>
      ) : (
        <div className="pb-4" />
      )}
    </div>
  )
}
