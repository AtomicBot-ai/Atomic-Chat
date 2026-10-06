import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { useModelProvider } from '@/hooks/useModelProvider'
import { managedPlanKey, useManagedPlan } from '@/hooks/useManagedPlan'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { managedEngine, providerKey, type ManagedEngine } from '@/lib/managed-engines'
import { formatBytes } from '@/lib/utils'
import {
  deriveSetupView,
  planSummary,
  type BlockerView,
  type OperationStep,
  type PlanSummary,
  type WarningView,
} from '@/lib/managed-engine/setup-view'
import {
  beginOperation,
  cancelOperation,
  resumeOperation,
  runHostStep,
  runtimeTarget,
} from '@/services/managed-environment/client'
import { describeDescriptor } from '@/services/managed-models/models'
import { useRunningHostSteps } from '@/stores/host-step-running-store'
import type {
  EnvironmentOperation,
  RequirementPlan,
  Sha256Digest,
} from '@/services/managed-environment/types'
import {
  selectEnvironment,
  selectFailedEnvironmentRemoval,
  selectFailedSetup,
  selectInstallation,
  selectOtherEngineOperation,
  selectSetupOperation,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * A managed engine's part of its provider page (Linux and Windows): whether this machine can run the
 * engine and why not, the whole plan before consent, the OS authorization prompt (`pkexec`, or UAC
 * to turn on WSL), the sign-in the Docker group needs or the restart WSL needs, the pull with its
 * bytes, and removing the engine (spec `tensorrt-llm-desktop`; the same for every managed engine,
 * change `add-vllm-runtime`, design D14).
 *
 * Everything shown comes from the core — its plan and its operation, which outlives this panel —
 * so closing the page and opening it again finds the same setup where it is.
 */

/** What the person agreed to, until the core asks for that consent. */
type Approval =
  | { kind: 'setup'; digest: Sha256Digest }
  | { kind: 'remove' }
  /** Windows: Atomic Chat's WSL distribution, with every model in it. */
  | { kind: 'remove-environment' }

/** One empty list for every render without models: a fresh `[]` would re-render forever. */
const NO_MODELS: Array<{ id: string }> = []

/**
 * Privileged steps already put to the OS prompt, and the ones whose prompt is still open. Module
 * state, not component state: leaving the provider page and opening it again must not raise a
 * second password prompt for a step whose executor may still be running.
 */
const promptedSteps = new Set<string>()
/**
 * Steps whose prompt is open, and why a privileged step failed, by operation: a store so every
 * mounted panel sees them, including one opened after the step ended. The core's own error for the
 * operation is generic; the executor's reason (the step, its exit code, its stderr) is only here.
 */
const useElevatingSteps = create<{ steps: string[]; failures: Record<string, string> }>()(() => ({
  steps: [],
  failures: {},
}))

export function resetHostStepPromptsForTests(): void {
  promptedSteps.clear()
  useElevatingSteps.setState({ steps: [], failures: {} })
}

const errorText = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)

export function ManagedEngineSetupPanel({ engine }: { engine: ManagedEngine }) {
  const { t } = useTranslation()
  const k = providerKey(engine)
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const installation = useManagedEnvironmentStore((state) => selectInstallation(state, engine.id))
  const operation = useManagedEnvironmentStore((state) => selectSetupOperation(state, engine.id))
  const anyOperation = useManagedEnvironmentStore((state) => selectSetupOperation(state))
  /** The other managed engines installed here: they keep using the shared models. */
  const modelUsers = (environment?.installations ?? [])
    .filter((entry) => entry.engine_id !== engine.id && entry.status === 'ready')
    .map((entry) => managedEngine(entry.engine_id)?.label ?? entry.engine_id)
  // Another engine's setup or removal: the core runs one at a time, so this install waits.
  const otherOperation = useManagedEnvironmentStore((state) =>
    operation ? undefined : selectOtherEngineOperation(state, engine.id)
  )
  const failed = useManagedEnvironmentStore((state) => selectFailedSetup(state, engine.id))
  const failedEnvironmentRemoval = useManagedEnvironmentStore(selectFailedEnvironmentRemoval)

  // The plan is shared with the Model Hub. This page asks on every opening — something may have
  // been fixed outside the app — and whenever what the plan depends on changes (the WSL
  // distribution going on Windows turns the page back to the install); never on a bare revision,
  // which the core bumps after every probe.
  const { plan, probing, error: probeError, recheck: probeAgain } = useManagedPlan(engine.id, {
    enabled: false,
  })
  const [actionError, setActionError] = useState<string | null>(null)
  const [planOpen, setPlanOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removeEnvironmentOpen, setRemoveEnvironmentOpen] = useState(false)
  const [keepModels, setKeepModels] = useState(true)
  const [manualCommand, setManualCommand] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const approval = useRef<Approval | null>(null)
  const answeredConsent = useRef<string | null>(null)
  const elevatingSteps = useElevatingSteps((state) => state.steps)
  const stepFailures = useElevatingSteps((state) => state.failures)

  /** Ask the core again what setting up would take on this machine; probing changes nothing. */
  const recheck = useCallback(() => {
    setActionError(null)
    return probeAgain()
  }, [probeAgain])

  const planKey = managedPlanKey(environment, engine.id)
  useEffect(() => {
    void recheck()
  }, [recheck, planKey])

  // The NVIDIA notices of the descriptor this plan installs; when the core cannot serve that
  // descriptor, the plan says the notices were not reported.
  const planDescriptor = plan?.descriptor_id ?? null
  useEffect(() => {
    setNotices([])
    if (!planDescriptor) return
    let cancelled = false
    void describeDescriptor(planDescriptor).then((summary) => {
      if (!cancelled) setNotices(summary?.notices ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [planDescriptor])

  const environmentId = environment?.environment_id ?? 'default'
  /** Atomic Chat's own WSL distribution runs Docker here (change `add-tensorrt-llm-windows`). */
  const windows = environment?.executor === 'wsl-docker'
  /** The models the provider lists — on Windows, the ones in the distribution. */
  const models = useModelProvider(
    (state) =>
      state.providers.find((provider) => provider.provider === engine.id)?.models ??
      NO_MODELS
  )

  const act = async (run: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await run()
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const agree = (shown: RequirementPlan) =>
    act(async () => {
      setPlanOpen(false)
      if (operation?.phase === 'awaiting-consent' && operation.plan_digest === shown.plan_digest) {
        // The core is already asking; answer it with the plan the person just read.
        answeredConsent.current = `${operation.operation_id}:${operation.revision}`
        await resumeOperation(operation.operation_id, operation.revision, shown.plan_digest)
        return
      }
      approval.current = { kind: 'setup', digest: shown.plan_digest }
      await beginOperation(environmentId, {
        request_id: crypto.randomUUID(),
        kind: 'setup',
        target: runtimeTarget(engine.id),
        ...(shown.descriptor_id ? { descriptor_id: shown.descriptor_id } : {}),
      })
    })

  // The core asks for consent on every operation. Approve exactly what the person agreed to here;
  // anything else — the machine changed, or this window never showed a plan — is shown first.
  useEffect(() => {
    if (operation?.phase !== 'awaiting-consent' || !operation.plan_digest) return
    const asked = `${operation.operation_id}:${operation.revision}`
    if (answeredConsent.current === asked) return
    answeredConsent.current = asked
    const agreed = approval.current
    approval.current = null
    // A removal this window did not start (or started before it was reopened): ask with the
    // removal's own dialog; confirming it approves what the core offers.
    const removesEnvironment = operation.kind === 'remove' && operation.target.kind === 'environment'
    if (removesEnvironment && agreed?.kind !== 'remove-environment') {
      setRemoveEnvironmentOpen(true)
      return
    }
    if (operation.kind === 'remove' && !removesEnvironment && agreed?.kind !== 'remove') {
      setRemoveOpen(true)
      return
    }
    const approves =
      (removesEnvironment && agreed?.kind === 'remove-environment') ||
      (!removesEnvironment && agreed?.kind === 'remove') ||
      (agreed?.kind === 'setup' && agreed.digest === operation.plan_digest)
    if (approves) {
      void act(() =>
        resumeOperation(operation.operation_id, operation.revision, operation.plan_digest as Sha256Digest)
      )
      return
    }
    void recheck().then((next) => {
      if (next) setPlanOpen(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation?.operation_id, operation?.phase, operation?.revision, operation?.plan_digest])

  // The privileged step: the OS prompt comes up once per step on its own; a retry is a button.
  const grant = useCallback((operationId: string, stepId: string) => {
    // One prompt at a time per step: a second executor would race the first over the package
    // manager, and its receipt would be refused.
    if (useElevatingSteps.getState().steps.includes(stepId)) return
    useElevatingSteps.setState(({ steps }) => ({ steps: [...steps, stepId] }))
    promptedSteps.add(stepId)
    setManualCommand(null)
    void runHostStep(operationId)
      .then((answer) => {
        if (answer.outcome === 'manual') setManualCommand(answer.command)
        if (answer.outcome === 'failed' && answer.log_tail) {
          const reason = answer.log_tail
          console.warn(`[${engine.id}] privileged step ${stepId} failed: ${reason}`)
          useElevatingSteps.setState(({ failures }) => ({
            failures: { ...failures, [operationId]: reason },
          }))
        }
      })
      .catch((error) => setActionError(errorText(error)))
      .finally(() => {
        useRunningHostSteps.getState().ended(stepId)
        useElevatingSteps.setState(({ steps }) => ({
          steps: steps.filter((step) => step !== stepId),
        }))
      })
  },[engine.id])

  useEffect(() => {
    const step = operation?.pending_host_step
    if (operation?.phase !== 'preparing-host' || !step) return
    if (promptedSteps.has(step.step_id)) return
    grant(operation.operation_id, step.step_id)
  }, [operation?.operation_id, operation?.phase, operation?.pending_host_step, grant])

  /**
   * Where UAC cannot be raised the person turns WSL on in an administrator terminal; no receipt
   * will come for this operation, so checking again gives it up and probes the machine anew.
   */
  const checkAgainAfterManualStep = (operationId: string) =>
    act(async () => {
      setManualCommand(null)
      await cancelOperation(operationId)
      await recheck()
    })

  const view = deriveSetupView({ plan, operation, installation, failed })
  const summary = plan ? planSummary(plan, notices, environment?.executor) : undefined
  /**
   * Windows only: every managed engine is gone and the distribution is still there. Removing it is
   * the one way to give back the space its disk image took (design D12); while any engine is
   * installed or being set up, the distribution is still that engine's.
   */
  const distribution = windows ? (environment?.distribution ?? null) : null
  const canRemoveEnvironment =
    distribution !== null &&
    !anyOperation &&
    !(environment?.installations ?? []).some((entry) => entry.status === 'ready')

  const removeEnvironment = () =>
    act(async () => {
      setRemoveEnvironmentOpen(false)
      if (
        operation?.kind === 'remove' &&
        operation.target.kind === 'environment' &&
        operation.phase === 'awaiting-consent' &&
        operation.plan_digest
      ) {
        // The core is already asking about this removal.
        answeredConsent.current = `${operation.operation_id}:${operation.revision}`
        await resumeOperation(operation.operation_id, operation.revision, operation.plan_digest)
        return
      }
      approval.current = { kind: 'remove-environment' }
      await beginOperation(environmentId, {
        request_id: crypto.randomUUID(),
        kind: 'remove',
        target: { kind: 'environment' },
      })
    })

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-main-view-fg/10 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium text-main-view-fg">{t(k('title'))}</h2>
          <p className="text-sm text-main-view-fg/70">{t(k('description'))}</p>
        </div>
      </div>

      {otherOperation && <OtherEngineOperation engine={engine} operation={otherOperation} />}

      {view.kind === 'checking' && (
        <p className="text-sm text-main-view-fg/70">{t(k('checking'))}</p>
      )}

      {view.kind === 'blocked' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t(k('blocked'))}</p>
          <Blockers engine={engine} blockers={view.blockers} />
          {summary?.disk.insufficient && <DiskLine engine={engine} summary={summary} />}
          <div>
            <Button variant="outline" size="sm" disabled={probing} onClick={() => void recheck()}>
              {t(k('checkAgain'))}
            </Button>
          </div>
        </div>
      )}

      {view.kind === 'not-installed' && (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-main-view-fg/70">
            {t(windows ? k('notInstalledWindows') : k('notInstalled'))}
          </p>
          <Button size="sm" disabled={probing || !!otherOperation} onClick={() => setPlanOpen(true)}>
            {t(k('install'))}
          </Button>
        </div>
      )}

      {view.kind === 'operation' && (
        <OperationStatus
          engine={engine}
          operation={view.operation}
          step={view.step}
          windows={windows}
          manualCommand={manualCommand}
          onCancel={() => void act(() => cancelOperation(view.operation.operation_id))}
          granting={elevatingSteps.includes(
            view.operation.pending_host_step?.step_id ?? ''
          )}
          onGrant={() =>
            view.operation.pending_host_step &&
            grant(view.operation.operation_id, view.operation.pending_host_step.step_id)
          }
          onReview={() =>
            view.operation.kind === 'remove' && view.operation.target.kind === 'environment'
              ? setRemoveEnvironmentOpen(true)
              : void recheck().then((next) => next && setPlanOpen(true))
          }
          onCheckAgain={() => void checkAgainAfterManualStep(view.operation.operation_id)}
        />
      )}

      {view.kind === 'failed' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t(k('failed'))}</p>
          <p className="text-sm text-destructive break-words">{view.operation.error?.message}</p>
          {stepFailures[view.operation.operation_id] && (
            <pre className="max-h-60 overflow-auto rounded bg-main-view-fg/5 p-2 text-xs whitespace-pre-wrap break-words">
              {stepFailures[view.operation.operation_id]}
            </pre>
          )}
          {view.newerPlan && (
            <p className="text-sm text-main-view-fg/70">{t(k('newerPlan'))}</p>
          )}
          <div className="flex gap-2">
            {view.newerPlan && (
              <Button size="sm" disabled={probing || !!otherOperation} onClick={() => setPlanOpen(true)}>
                {t(k('install'))}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!!otherOperation}
              onClick={() =>
                void act(() => resumeOperation(view.operation.operation_id, view.operation.revision))
              }
            >
              {t(k('retry'))}
            </Button>
          </div>
        </div>
      )}

      {view.kind === 'installed' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t(k('installed'))}</p>
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-main-view-fg/70">
              {t(windows ? k('remove.spaceWindows') : k('remove.space'), {
                size: formatBytes(plan?.required_disk_bytes ?? undefined),
              })}
            </p>
            <Button variant="outline" size="sm" onClick={() => setRemoveOpen(true)}>
              {t(k('remove.button'))}
            </Button>
          </div>
        </div>
      )}

      {canRemoveEnvironment && distribution && (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-main-view-fg/70 break-words">
            {t(k('removeEnvironment.hint'), {
              name: distribution.name,
              size: formatBytes(distribution.size_bytes ?? undefined),
            })}
          </p>
          <Button variant="outline" size="sm" onClick={() => setRemoveEnvironmentOpen(true)}>
            {t(k('removeEnvironment.button'))}
          </Button>
        </div>
      )}
      {canRemoveEnvironment && failedEnvironmentRemoval?.error && (
        <p className="text-sm text-destructive break-words">{failedEnvironmentRemoval.error.message}</p>
      )}

      {(actionError ?? probeError) && (
        <p className="text-sm text-destructive break-words">{actionError ?? probeError}</p>
      )}

      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(k('plan.title'))}</DialogTitle>
            <DialogDescription>{t(k('plan.intro'))}</DialogDescription>
          </DialogHeader>
          {plan && summary && <PlanDetails engine={engine} summary={summary} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlanOpen(false)}>
              {t(k('plan.cancel'))}
            </Button>
            <Button disabled={!plan || !summary?.canStart} onClick={() => plan && void agree(plan)}>
              {t(k('plan.agree'))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(k('remove.title'))}</DialogTitle>
            <DialogDescription>
              {t(windows ? k('remove.bodyWindows') : k('remove.body'))}
            </DialogDescription>
          </DialogHeader>
          {modelUsers.length > 0 ? (
            // The store's models go only with the last managed engine (design D13).
            <p className="text-sm text-main-view-fg/70">
              {t(k('remove.modelsStay'), { engines: modelUsers.join(', ') })}
            </p>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={keepModels}
                onChange={(event) => setKeepModels(event.target.checked)}
              />
              {t(k('remove.keepModels'))}
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>
              {t(k('plan.cancel'))}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                void act(async () => {
                  setRemoveOpen(false)
                  if (
                    operation?.kind === 'remove' &&
                    operation.target.kind === 'runtime' &&
                    operation.phase === 'awaiting-consent' &&
                    operation.plan_digest
                  ) {
                    // The core is already asking about this removal.
                    answeredConsent.current = `${operation.operation_id}:${operation.revision}`
                    await resumeOperation(
                      operation.operation_id,
                      operation.revision,
                      operation.plan_digest
                    )
                    return
                  }
                  approval.current = { kind: 'remove' }
                  await beginOperation(environmentId, {
                    request_id: crypto.randomUUID(),
                    kind: 'remove',
                    target: runtimeTarget(engine.id),
                    retain_models: keepModels || modelUsers.length > 0,
                  })
                })
              }
            >
              {t(k('remove.confirm'))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeEnvironmentOpen} onOpenChange={setRemoveEnvironmentOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(k('removeEnvironment.title'))}</DialogTitle>
            <DialogDescription className="break-words">
              {t(k('removeEnvironment.body'), {
                name: environment?.distribution?.name ?? '',
                path: environment?.distribution?.path ?? '',
                size: formatBytes(environment?.distribution?.size_bytes ?? undefined),
              })}
            </DialogDescription>
          </DialogHeader>
          {models.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <p className="font-medium">{t(k('removeEnvironment.models'))}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {models.map((model) => (
                  <li key={model.id} className="break-words">
                    {model.id}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm">{t(k('removeEnvironment.noModels'))}</p>
          )}
          <p className="text-sm text-main-view-fg/70">{t(k('removeEnvironment.uninstall'))}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveEnvironmentOpen(false)}>
              {t(k('plan.cancel'))}
            </Button>
            <Button variant="destructive" onClick={() => void removeEnvironment()}>
              {t(k('removeEnvironment.confirm'))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Another managed engine's setup or removal is running: this engine's install waits for it — the
 * core runs one environment operation at a time — so the page says so instead of offering a start
 * the core would refuse as a conflict. The phase is in the other engine's own words.
 */
function OtherEngineOperation({
  engine,
  operation,
}: {
  engine: ManagedEngine
  operation: EnvironmentOperation
}) {
  const { t } = useTranslation()
  const other =
    operation.target.kind === 'runtime' ? managedEngine(operation.target.engine_id) : undefined
  const engineName =
    other?.label ?? (operation.target.kind === 'runtime' ? operation.target.engine_id : '')
  const phase = other ? t(providerKey(other)(`phase.${operation.phase}`)) : operation.phase
  return (
    <p className="text-sm text-main-view-fg/70 break-words">
      {t(providerKey(engine)('otherOperation'), { engine: engineName, phase })}
    </p>
  )
}

function Blockers({ engine, blockers }: { engine: ManagedEngine; blockers: BlockerView[] }) {
  const { t } = useTranslation()
  const k = providerKey(engine)
  return (
    <ul className="flex flex-col gap-2">
      {blockers.map((blocker, index) => (
        <li key={index} className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="break-words">
            {blocker.ampere
              ? t(k('blocker.ampere'), blocker.ampere)
              : blocker.message}
          </span>
          {blocker.commands.length > 0 && (
            <pre className="select-all overflow-x-auto rounded bg-main-view-fg/5 p-2 text-xs">
              {blocker.commands.join('\n')}
            </pre>
          )}
        </li>
      ))}
    </ul>
  )
}

function DiskLine({ engine, summary }: { engine: ManagedEngine; summary: PlanSummary }) {
  const { t } = useTranslation()
  const k = providerKey(engine)
  const { location, path, requiredBytes, freeBytes } = summary.disk
  const required = formatBytes(requiredBytes ?? undefined)
  // On Windows the space is the WSL distribution's, on the volume that holds its folder.
  const key = (name: 'disk' | 'diskNoFree' | 'diskNoPath' | 'diskUnknown') =>
    location === 'distribution'
      ? k(`plan.wsl${name[0].toUpperCase()}${name.slice(1)}`)
      : k(`plan.${name}`)
  if (path === null) {
    // The core measured nothing this time (the free-space read failed).
    return (
      <p className="text-sm break-words">
        {freeBytes !== null
          ? t(key('diskNoPath'), { required, free: formatBytes(freeBytes) })
          : t(key('diskUnknown'), { required })}
      </p>
    )
  }
  return (
    <p className="text-sm break-words">
      {freeBytes !== null
        ? t(key('disk'), { path, required, free: formatBytes(freeBytes) })
        : t(key('diskNoFree'), { path, required })}
    </p>
  )
}

/** Above everything else in the plan: each is a reason the install may not work out as agreed. */
function PlanWarnings({ engine, warnings }: { engine: ManagedEngine; warnings: WarningView[] }) {
  const { t } = useTranslation()
  const k = providerKey(engine)
  return (
    <ul className="flex flex-col gap-2 rounded border border-amber-600/40 bg-amber-600/10 p-2">
      {warnings.map((warning, index) => (
        <li key={index} className="flex min-w-0 flex-col gap-1">
          {warning.addressPools && (
            <>
              <p className="break-words font-medium text-amber-600">
                {warning.addressPools.routes
                  ? t(k('plan.warning.addressPools'), {
                      routes: warning.addressPools.routes,
                    })
                  : t(k('plan.warning.addressPoolsNoRoutes'))}
              </p>
              <p className="break-words">{t(k('plan.warning.addressPoolsFix'))}</p>
            </>
          )}
          <p className={warning.addressPools ? 'break-words text-main-view-fg/70' : 'break-words'}>
            {warning.text}
          </p>
        </li>
      ))}
    </ul>
  )
}

function PlanDetails({ engine, summary }: { engine: ManagedEngine; summary: PlanSummary }) {
  const { t } = useTranslation()
  const k = providerKey(engine)
  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      {summary.warnings.length > 0 && <PlanWarnings engine={engine} warnings={summary.warnings} />}
      {summary.changes.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {summary.changes.map((change, index) => (
            <li
              key={index}
              className={change.warning ? 'break-words font-medium text-amber-600' : 'break-words'}
            >
              {change.text}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t(k('plan.noSystemChanges'))}</p>
      )}
      {summary.relogin && <p className="font-medium">{t(k('plan.relogin'))}</p>}
      {summary.reboot && <p className="font-medium">{t(k('plan.reboot'))}</p>}
      {summary.downloadBytes !== null && (
        <p>
          {t(k('plan.download'), {
            size: formatBytes(summary.downloadBytes),
          })}
        </p>
      )}
      <DiskLine engine={engine} summary={summary} />
      {summary.notices.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t(k('plan.notices'))}</p>
          {summary.notices.map((notice, index) => (
            <p key={index} className="break-words text-main-view-fg/70">
              {notice}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-main-view-fg/70">{t(k('plan.noticesMissing'))}</p>
      )}
      {summary.blockers.length > 0 && <Blockers engine={engine} blockers={summary.blockers} />}
    </div>
  )
}

function OperationStatus({
  engine,
  operation,
  step,
  windows,
  manualCommand,
  granting,
  onCancel,
  onGrant,
  onReview,
  onCheckAgain,
}: {
  engine: ManagedEngine
  operation: EnvironmentOperation
  step: OperationStep
  /** The environment is Atomic Chat's WSL distribution: some phases mean something else here. */
  windows: boolean
  manualCommand: string | null
  /** The OS prompt for this step is open; asking again would start a second executor. */
  granting: boolean
  onCancel: () => void
  onGrant: () => void
  onReview: () => void
  /** After turning WSL on by hand: give this operation up and look at the machine again. */
  onCheckAgain: () => void
}) {
  const { t } = useTranslation()
  const k = providerKey(engine)
  // `preparing-host` turns WSL on; `preparing-environment` imports and sets up the distribution;
  // `removing` an environment unregisters the distribution, not the engine.
  const phaseKey =
    operation.target.kind === 'environment' && operation.phase === 'removing'
      ? k('removeEnvironment.removing')
      : windows && (operation.phase === 'preparing-host' || operation.phase === 'preparing-environment')
        ? k(`phaseWindows.${operation.phase}`)
        : k(`phase.${operation.phase}`)
  /** The privileged step is UAC turning on WSL, not the system password. */
  const uac = operation.pending_host_step?.action === 'windows.enable-wsl'
  const runningSteps = useRunningHostSteps((state) => state.steps)
  const running =
    operation.pending_host_step !== null && runningSteps.includes(operation.pending_host_step.step_id)
  const progress = operation.progress
  const bytes =
    progress?.unit === 'bytes' && progress.completed !== null && progress.total
      ? {
          done: formatBytes(progress.completed),
          total: formatBytes(progress.total),
          percent: Math.min(100, (progress.completed / progress.total) * 100),
        }
      : null

  return (
    <div className="flex flex-col gap-2">
      {step === 'relogin' ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t(k('relogin.title'))}</p>
          <p className="text-sm text-main-view-fg/70">{t(k('relogin.body'))}</p>
          <p className="text-sm text-main-view-fg/70">
            {t(k('relogin.stillWaiting'))}
          </p>
        </div>
      ) : step === 'reboot' ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t(k('reboot.title'))}</p>
          <p className="text-sm text-main-view-fg/70">{t(k('reboot.body'))}</p>
        </div>
      ) : (
        <p className="text-sm font-medium">{t(phaseKey)}</p>
      )}

      {bytes && (
        <div className="flex flex-col gap-1">
          <Progress value={bytes.percent} />
          <p className="truncate text-xs tabular-nums text-main-view-fg/70">
            {t(k('progress'), { done: bytes.done, total: bytes.total })}
          </p>
        </div>
      )}

      {step === 'host-step' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-main-view-fg/70">
            {manualCommand
              ? t(uac ? k('hostStep.uac.manual') : k('hostStep.manual'))
              : running
                ? t(uac ? k('hostStep.uac.running') : k('hostStep.running'))
                : t(uac ? k('hostStep.uac.waiting') : k('hostStep.waiting'))}
          </p>
          {manualCommand && (
            <pre className="select-all overflow-x-auto rounded bg-main-view-fg/5 p-2 text-xs">
              {manualCommand}
            </pre>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={granting} onClick={onGrant}>
              {t(uac ? k('hostStep.uac.retry') : k('hostStep.retry'))}
            </Button>
            {manualCommand && uac && (
              <Button variant="outline" size="sm" onClick={onCheckAgain}>
                {t(k('checkAgain'))}
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 'consent' && (
        <div>
          <Button size="sm" onClick={onReview}>
            {t(k('consent.review'))}
          </Button>
        </div>
      )}

      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={operation.cancellation_requested || operation.phase === 'cancelling'}
          onClick={onCancel}
        >
          {t(k('cancel'))}
        </Button>
      </div>
    </div>
  )
}
