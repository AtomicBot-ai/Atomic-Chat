import { useEffect, useRef, useState } from 'react'
import { IconLoader2, IconRefresh } from '@tabler/icons-react'
import { invoke } from '@tauri-apps/api/core'

import {
  CORNER_ACTION,
  CORNER_CARD,
  CORNER_PRIMARY_ACTION,
  CornerCardHeader,
  CornerMini,
  CornerProgressLine,
} from '@/containers/corner/CornerCard'
import { CORNER_ORDER, CornerSlot } from '@/containers/corner/cornerStack'
import { useAutoCollapse } from '@/containers/corner/useAutoCollapse'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { stepOf } from '@/lib/managed-engine/setup-view'
import { managedEngine, managedEngines, providerKey } from '@/lib/managed-engines'
import { formatBytes } from '@/lib/utils'
import type { EnvironmentOperation } from '@/services/managed-environment/types'
import { useRunningHostSteps } from '@/stores/host-step-running-store'
import {
  selectEnvironment,
  selectSetupOperation,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * A managed engine's setup or removal in progress (whichever engine it is: the card speaks with that
 * engine's texts), as one of the corner's notification cards (the same column and look as the
 * download panel and the update banners, `corner/CornerCard`): the phase in words, the bytes while
 * the image downloads, and — only when the step needs it — the one action left to the person:
 * restart Windows after WSL was turned on, or sign out on Linux after the `docker` group was added
 * (Rust `atomic_core_finish_session_step`). After the UAC approval Windows installs WSL for minutes
 * with no window, so the card says that instead of asking for approval.
 *
 * Like the other corner cards it folds into a pill three seconds after it appears; each new phase
 * opens it again for another three, so a step that waits for the person is never only a pill.
 */
export function ManagedEngineOperationBar() {
  const operation = useManagedEnvironmentStore((state) => selectSetupOperation(state))
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
  // The engine the operation sets up or removes; the environment's own removal is every engine's,
  // and its texts are the same in every engine's block.
  const engine =
    operation.target.kind === 'runtime' ? managedEngine(operation.target.engine_id) : undefined
  const k = providerKey(engine ?? managedEngines()[0])
  // The card is titled by the engine it sets up; the environment (Atomic Chat's WSL distribution)
  // is every managed engine's.
  const title =
    engine?.label ??
    (operation.target.kind === 'runtime'
      ? operation.target.engine_id
      : managedEngines()
          .map((entry) => entry.label)
          .join(' / '))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const step = stepOf(operation)

  const text =
    step === 'host-step'
      ? hostStepRunning
        ? t(windows ? k('hostStep.uac.running') : k('hostStep.running'))
        : t(windows ? k('bar.hostStepWindows') : k('bar.hostStep'))
      : step === 'reboot'
        ? t(k('bar.reboot'))
        : step === 'relogin'
          ? t(k('bar.relogin'))
          : operation.target.kind === 'environment' && operation.phase === 'removing'
            ? t(k('removeEnvironment.removing'))
            : windows &&
                (operation.phase === 'preparing-host' ||
                  operation.phase === 'preparing-environment')
              ? t(k(`phaseWindows.${operation.phase}`))
              : t(k(`phase.${operation.phase}`))

  const progress = operation.progress
  const bytes =
    progress?.unit === 'bytes' && progress.completed !== null && progress.total
      ? { completed: progress.completed, total: progress.total }
      : null

  const action: { name: 'restart' | 'sign-out'; label: string } | null =
    step === 'reboot' && windows
      ? { name: 'restart', label: t(k('bar.restartNow')) }
      : step === 'relogin' && !windows
        ? { name: 'sign-out', label: t(k('bar.signOutNow')) }
        : null

  const run = async (name: 'restart' | 'sign-out') => {
    setBusy(true)
    setError(null)
    try {
      await invoke('atomic_core_finish_session_step', { action: name })
    } catch (e) {
      setError(
        t(k('bar.actionFailed'), {
          error: e instanceof Error ? e.message : String(e),
        })
      )
    } finally {
      setBusy(false)
    }
  }

  const phaseKey = `${operation.operation_id}:${operation.phase}:${step}`
  const { collapsed, expand, collapse, peek, holdProps } = useAutoCollapse(true)
  const shownPhase = useRef(phaseKey)
  useEffect(() => {
    if (shownPhase.current === phaseKey) return
    shownPhase.current = phaseKey
    peek()
  }, [phaseKey, peek])

  const fraction = bytes ? bytes.completed / bytes.total : null
  const icon = (size: number) =>
    action ? (
      <IconRefresh size={size} aria-hidden />
    ) : (
      <IconLoader2 size={size} aria-hidden className="animate-spin" />
    )

  if (collapsed) {
    return (
      <CornerSlot order={CORNER_ORDER.managedEngine}>
        <CornerMini
          icon={icon(15)}
          text={fraction !== null ? `${Math.round(fraction * 100)}%` : title}
          progress={fraction}
          label={title}
          onClick={expand}
          testId="managed-operation-bar-mini"
        />
      </CornerSlot>
    )
  }

  return (
    <CornerSlot order={CORNER_ORDER.managedEngine}>
      <div
        role="status"
        aria-live="polite"
        data-testid="managed-operation-bar"
        className={CORNER_CARD}
        {...holdProps}
      >
        <CornerCardHeader
          title={title}
          collapseLabel={t('common:cornerCard.collapse')}
          onCollapse={collapse}
          dismissLabel={t(k('bar.later'))}
          onDismiss={onDismiss}
        />

        <div className="bg-[var(--dl-row)]">
          <div className="flex items-start gap-3 px-4 py-3">
            <span className="flex shrink-0 pt-px text-[var(--dl-strong)]">{icon(18)}</span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold leading-[18px] break-words text-[var(--dl-title)]">
                {text}
              </p>
              {bytes ? (
                <p className="mt-0.5 text-[11px] leading-4 tabular-nums text-[var(--dl-text)]">
                  {formatBytes(bytes.completed)} / {formatBytes(bytes.total)}
                </p>
              ) : null}
              {error ? (
                <p className="mt-1 text-[11px] leading-4 break-words text-destructive">{error}</p>
              ) : null}
            </div>
            {fraction !== null ? (
              <b className="shrink-0 text-xs font-medium leading-[18px] tabular-nums text-[var(--dl-strong)]">
                {Math.round(fraction * 100)}%
              </b>
            ) : null}
          </div>
          {fraction !== null ? <CornerProgressLine progress={fraction} label={title} /> : null}
        </div>

        {action ? (
          <div className="flex flex-wrap items-center justify-end gap-1 border-t border-[var(--dl-divider)] px-2 py-2">
            <button type="button" className={CORNER_ACTION} onClick={onDismiss}>
              {t(k('bar.later'))}
            </button>
            <button
              type="button"
              className={CORNER_PRIMARY_ACTION}
              disabled={busy}
              onClick={() => void run(action.name)}
            >
              {action.label}
            </button>
          </div>
        ) : null}
      </div>
    </CornerSlot>
  )
}
