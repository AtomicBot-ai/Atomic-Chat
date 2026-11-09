import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  FastFlowLmOperation,
  FastFlowLmProbePlan,
} from '@atomic-chat/core/contracts'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  beginFastFlowLmPreparation,
  consentFastFlowLmPreparation,
  fastFlowLmOperations,
  probeFastFlowLm,
  resumeFastFlowLmPreparation,
  cancelFastFlowLmPreparation,
} from '@/services/fastflowlm/core'

type DesktopOperation = FastFlowLmOperation & {
  desktop_host_step?: { kind: 'terminal' | 'manual'; command: string }
}

const REQUEST_KEY = 'atomic_fastflowlm_preparation_request_v1'
const terminal = (op: FastFlowLmOperation) =>
  ['ready', 'failed', 'cancelled'].includes(op.state)
const message = (e: unknown) =>
  typeof (e as { message?: unknown })?.message === 'string'
    ? (e as Error).message
    : String(e)

/** Readiness never gates the engine's independent settings UI. Commands from core are display-only. */
export function FastFlowLmPreparation() {
  const { t } = useTranslation()
  const [plan, setPlan] = useState<FastFlowLmProbePlan>()
  const [operation, setOperation] = useState<FastFlowLmOperation>()
  const [recovered, setRecovered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [authorization, setAuthorization] = useState<{
    operationId: string
    stepId?: string
    prompt: NonNullable<DesktopOperation['desktop_host_step']>
  }>()

  const refresh = async () => {
    setError(undefined)
    try {
      setPlan(await probeFastFlowLm())
    } catch (e) {
      setError(message(e))
    }
  }
  useEffect(() => {
    let alive = true
    void probeFastFlowLm()
      .then((p) => {
        if (alive) setPlan(p)
      })
      .catch((e) => {
        if (alive) setError(message(e))
      })
    void fastFlowLmOperations()
      .then((ops) => {
        if (!alive) return
        const requestId = localStorage.getItem(REQUEST_KEY)
        if (ops.some((op) => op.request_id === requestId && terminal(op)))
          localStorage.removeItem(REQUEST_KEY)
        setOperation(
          ops.find((op) => !terminal(op)) ??
            ops.find((op) => op.state === 'failed')
        )
        setRecovered(true)
      })
      .catch((e) => {
        if (alive) setError(message(e))
      })
    const listeners = Promise.all([
      listen<FastFlowLmOperation>(
        'atomic-core://fastflowlm:operation',
        ({ payload }) => {
          if (alive)
            setOperation((current) =>
              !current ||
              (current.operation_id === payload.operation_id &&
                payload.revision >= current.revision)
                ? payload
                : current
            )
        }
      ),
      listen('atomic-core://snapshot', () => {
        void fastFlowLmOperations()
          .then((ops) => {
            if (alive)
              setOperation(
                ops.find((op) => !terminal(op)) ??
                  ops.find((op) => op.state === 'failed')
              )
          })
          .catch((e) => {
            if (alive) setError(message(e))
          })
      }),
    ]).catch(() => [])
    return () => {
      alive = false
      void listeners.then((items) => items.forEach((unlisten) => unlisten()))
    }
  }, [])

  const run = async (action: () => Promise<DesktopOperation>) => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await action()
      if (next.desktop_host_step)
        setAuthorization({
          operationId: next.operation_id,
          stepId: next.pending_host_step?.step_id,
          prompt: next.desktop_host_step,
        })
      setOperation((current) =>
        current?.operation_id === next.operation_id &&
        current.revision > next.revision
          ? current
          : next
      )
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const begin = () =>
    run(async () => {
      const id = localStorage.getItem(REQUEST_KEY) ?? crypto.randomUUID()
      localStorage.setItem(REQUEST_KEY, id)
      return beginFastFlowLmPreparation(id)
    })
  const approve = () =>
    operation &&
    run(async () => {
      const approved = await consentFastFlowLmPreparation(
        operation.operation_id,
        {
          expected_revision: operation.revision,
          approved_plan_digest: operation.plan.plan_digest,
        }
      )
      setOperation(approved)
      // Native code durably claims this step and recovers a receipt without relaunching an unknown helper.
      return invoke<DesktopOperation>('atomic_fastflowlm_run_host_step', {
        operationId: approved.operation_id,
      })
    })
  const recover = () =>
    operation &&
    run(async () => {
      const resumed = await resumeFastFlowLmPreparation(
        operation.operation_id,
        operation.revision
      )
      if (resumed.state === 'preparing-host') {
        return invoke<DesktopOperation>('atomic_fastflowlm_run_host_step', {
          operationId: resumed.operation_id,
        })
      }
      return resumed
    })

  return (
    <section
      aria-label={t('providers:fastflowlm.preparation')}
      className="space-y-3 min-w-0 rounded-lg border p-4"
    >
      <h2 className="font-medium">{t('providers:fastflowlm.preparation')}</h2>
      <p role="status" className="break-words">
        {plan
          ? t(`providers:fastflowlm.${plan.status}`)
          : t('providers:fastflowlm.checking')}
      </p>
      {plan?.driver_setup && (
        <div className="space-y-2 min-w-0">
          <p>{plan.driver_setup.title}</p>
          {plan.driver_setup.steps.map((step, i) => (
            <p key={i} className="text-sm">
              {step}
            </p>
          ))}
          {plan.driver_setup.commands.length > 0 && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">
              {plan.driver_setup.commands.join('\n')}
            </pre>
          )}
          {plan.driver_setup.links
            .filter((link) => link.url.startsWith('https://'))
            .map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm underline"
              >
                {link.label}
              </a>
            ))}
        </div>
      )}
      {plan?.blockers.map((blocker) => (
        <p key={blocker} className="break-words text-sm text-muted-foreground">
          {t(`providers:fastflowlm.blockers.${blocker}`, {
            defaultValue: blocker.replace(/-/g, ' '),
          })}
        </p>
      ))}
      {operation && (
        <div className="space-y-2">
          <p role="status" className="break-words">
            {t(`providers:fastflowlm.operation.${operation.state}`)}
          </p>
          {operation.reason && (
            <p className="text-sm break-words">{operation.reason}</p>
          )}
          {operation.state === 'preparing-host' &&
            authorization?.operationId === operation.operation_id &&
            authorization.stepId === operation.pending_host_step?.step_id && (
              <div className="min-w-0 space-y-2">
                <p className="text-sm">
                  {t(
                    `providers:fastflowlm.authorization.${authorization.prompt.kind}`
                  )}
                </p>
                {authorization.prompt.kind === 'manual' && (
                  <pre className="whitespace-pre-wrap break-all text-xs select-text">
                    {authorization.prompt.command}
                  </pre>
                )}
              </div>
            )}
          {operation.state === 'awaiting-consent' && (
            <>
              {operation.plan.runtime_account && (
                <p className="text-sm break-words">
                  {t('providers:fastflowlm.account', {
                    account: operation.plan.runtime_account,
                    service: operation.plan.runtime_service ?? 'Atomic Chat',
                  })}
                </p>
              )}
              {operation.plan.packages?.map((pkg) => (
                <p key={pkg.name} className="break-all text-xs">
                  {pkg.name} {pkg.version} · {pkg.source} · SHA-256 {pkg.sha256}
                </p>
              ))}
              {operation.plan.changes.map((change) => (
                <p key={change.code} className="text-sm">
                  {change.text}
                </p>
              ))}
              <Button disabled={busy} onClick={() => void approve()}>
                {t('providers:fastflowlm.approve')}
              </Button>
            </>
          )}
          {!terminal(operation) && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  cancelFastFlowLmPreparation(operation.operation_id)
                )
              }
            >
              {t('providers:fastflowlm.cancel')}
            </Button>
          )}
          {[
            'preparing-host',
            'reboot-required',
            'relogin-required',
            'failed',
          ].includes(operation.state) && (
            <Button disabled={busy} onClick={() => void recover()}>
              {t('providers:fastflowlm.continue')}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {t('providers:fastflowlm.checkAgain')}
        </Button>
        {recovered && plan?.status === 'action-required' && !operation && (
          <Button disabled={busy} onClick={() => void begin()}>
            {t('providers:fastflowlm.prepare')}
          </Button>
        )}
      </div>
    </section>
  )
}
