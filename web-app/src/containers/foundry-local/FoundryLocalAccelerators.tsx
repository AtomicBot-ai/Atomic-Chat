import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  foundryLocalAccelerators,
  prepareFoundryLocalAccelerators,
} from '@/services/foundry-local/core'
import type {
  FoundryLocalAccelerator,
  FoundryLocalAccelerators as AcceleratorsAnswer,
  FoundryLocalAcceleratorsEvent,
  FoundryLocalExecutionProvider,
} from '@/services/foundry-local/types'

import { useFoundryLocalInstallStore } from './install-store'

/** The core's `foundry-local:accelerators`, as the relay names it. */
const PREPARE_EVENT = 'atomic-core://foundry-local:accelerators'

/** How the accelerators are named on the page. */
const LABELS: Record<FoundryLocalExecutionProvider, string> = {
  cpu: 'CPU',
  cuda: 'NVIDIA CUDA',
  webgpu: 'WebGPU',
  openvino: 'Intel OpenVINO',
  qnn: 'Qualcomm QNN',
  vitisai: 'AMD Vitis AI',
}

/** How long a prepare this page follows may stay silent before Prepare is offered again. */
const WATCH_QUIET_MS = 30_000

type Step = Pick<FoundryLocalAcceleratorsEvent, 'stage' | 'fraction' | 'reason'>

const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(error)
}

/**
 * Foundry Local's accelerators on the provider page (spec `foundry-local-desktop`, "Страница
 * провайдера ставит движок и готовит ускорители"): what the library of the installed build finds
 * here, which of them are prepared, and the step that prepares them — the library downloads them
 * (CUDA and WebGPU from Microsoft's CDN, NPU plugins through Windows ML) only when the person asks:
 * right after they installed or updated the engine on this page (all of them, once), or with
 * Prepare / Retry here.
 *
 * Progress comes as the core's `foundry-local:accelerators` events: a fraction for a CDN download,
 * only a start and an end for Windows ML. They are followed while the block is open, whoever
 * started the prepare: one still running when the page is opened again shows its progress here, and
 * a Prepare the core refuses as busy turns into following it. One accelerator failing does not stop
 * the others; a failed one keeps its reason and gets its own retry. An accelerator no variant runs on
 * (TensorRT-RTX, `execution_provider: null`) is not shown and never prepared.
 */
export function FoundryLocalAccelerators() {
  const { t } = useTranslation()
  const [answer, setAnswer] = useState<AcceleratorsAnswer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** This page's own prepare is waiting for the core's answer. */
  const [preparing, setPreparing] = useState(false)
  /** The core refused this page's prepare as busy: it follows the prepare already running. */
  const [watching, setWatching] = useState(false)
  const [steps, setSteps] = useState<Record<string, Step>>({})
  /** The accelerators of the prepare in flight: "Preparing…" before the core reports a step. */
  const [inFlight, setInFlight] = useState<string[]>([])
  const [prepareError, setPrepareError] = useState<string | null>(null)

  const read = useCallback(async (force = false) => {
    try {
      setAnswer(await foundryLocalAccelerators(force ? { force: true } : {}))
      setLoadError(null)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  // The core's steps are followed for as long as the block is open, not only during a prepare this
  // page started: one started before the page was opened again (another page, a reload) keeps
  // reporting, and its progress belongs here as much as this page's own.
  const mounted = useRef(true)
  const unlisten = useRef<(() => void) | null>(null)
  const follow = useCallback(async () => {
    if (unlisten.current) return
    const stop = await listen<FoundryLocalAcceleratorsEvent>(PREPARE_EVENT, (event) => {
      const { accelerator, stage, fraction, reason } = event.payload
      setSteps((current) => ({ ...current, [accelerator]: { stage, fraction, reason } }))
    })
    if (mounted.current) unlisten.current = stop
    else stop()
  }, [])
  useEffect(() => {
    mounted.current = true
    // A failure here is tried again by Prepare, which says so if it fails too.
    follow().catch(() => {})
    return () => {
      mounted.current = false
      unlisten.current?.()
      unlisten.current = null
    }
  }, [follow])

  /** Read what the library registered, then forget the steps it replaces. */
  const settle = useCallback(async () => {
    // The core forgets its probe after a prepare: this read shows what the library registered.
    await read()
    setWatching(false)
    setInFlight([])
    setSteps({})
  }, [read])

  const prepare = async (names: string[]) => {
    if (names.length === 0 || preparing || watching) return
    setPreparing(true)
    setInFlight(names)
    setPrepareError(null)
    setSteps({})
    let busy = false
    try {
      // Before the call: the core reports steps before it answers.
      await follow()
      await prepareFoundryLocalAccelerators(names)
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code
      if (code === 'ENGINE_INSTALL_IN_PROGRESS') busy = true
      else setPrepareError(t('providers:foundryLocal.accelerators.prepareFailed', { message: messageOf(error) }))
    } finally {
      setPreparing(false)
      if (busy) setWatching(true)
      else await settle()
    }
  }

  const stepActive = (step: Step | undefined) => step?.stage === 'started' || step?.stage === 'downloading'
  const anyActive = Object.values(steps).some(stepActive)

  // Following someone else's prepare: it is over once every accelerator it was waited for has
  // reported its end. One it never names (that prepare covered fewer) is given up on after a quiet
  // spell, so Prepare comes back instead of the page waiting forever.
  useEffect(() => {
    if (!watching || anyActive) return
    const ended = inFlight.every((name) => steps[name]?.stage === 'done' || steps[name]?.stage === 'failed')
    const timer = setTimeout(() => void settle(), ended ? 0 : WATCH_QUIET_MS)
    return () => clearTimeout(timer)
  }, [watching, anyActive, inFlight, steps, settle])

  const busy = preparing || watching || anyActive

  // Right after an install from this page: every accelerator a variant runs on, once.
  const justInstalled = useFoundryLocalInstallStore((state) => state.justInstalled)
  useEffect(() => {
    if (!answer?.installed || !justInstalled || answer.build !== justInstalled || busy) return
    useFoundryLocalInstallStore.setState({ justInstalled: null })
    const names = answer.accelerators
      .filter((accelerator) => accelerator.execution_provider !== null && !accelerator.prepared)
      .map((accelerator) => accelerator.name)
    void prepare(names)
    // `prepare` reads the state it needs when it runs; the answer and the mark decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, justInstalled])

  if (loadError) {
    return (
      <Card header={<Header />}>
        <p className="text-sm text-destructive">{loadError}</p>
      </Card>
    )
  }
  if (!answer || !answer.installed) return null

  const shown = answer.accelerators.filter(
    (accelerator): accelerator is FoundryLocalAccelerator & {
      execution_provider: FoundryLocalExecutionProvider
    } => accelerator.execution_provider !== null
  )
  // A step the core reported wins over the answer read before it.
  const isPrepared = (accelerator: FoundryLocalAccelerator) => {
    const stage = steps[accelerator.name]?.stage
    return stage === 'done' || (accelerator.prepared && stage !== 'failed')
  }
  const reasonOf = (accelerator: FoundryLocalAccelerator) => {
    const step = steps[accelerator.name]
    if (step?.stage === 'failed') return step.reason ?? accelerator.reason ?? ''
    return step || isPrepared(accelerator) ? undefined : accelerator.reason
  }
  const unprepared = shown.filter((accelerator) => !isPrepared(accelerator))

  const status = (accelerator: FoundryLocalAccelerator) => {
    const step = steps[accelerator.name]
    if (stepActive(step)) {
      return typeof step?.fraction === 'number' ? (
        <div className="flex w-40 flex-col items-end gap-1">
          <span className="text-xs">
            {t('providers:foundryLocal.accelerators.downloading', {
              percent: Math.round(step.fraction * 100),
            })}
          </span>
          <Progress value={step.fraction * 100} className="h-1" />
        </div>
      ) : (
        <span className="text-xs">{t('providers:foundryLocal.accelerators.preparing')}</span>
      )
    }
    if (isPrepared(accelerator)) {
      return (
        <span className="text-xs text-emerald-600 dark:text-emerald-400">
          {t('providers:foundryLocal.accelerators.ready')}
        </span>
      )
    }
    // Asked for, nothing reported yet (a Windows ML accelerator waits its turn without a word).
    if (!step && inFlight.includes(accelerator.name)) {
      return <span className="text-xs">{t('providers:foundryLocal.accelerators.preparing')}</span>
    }
    if (reasonOf(accelerator) !== undefined) {
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void prepare([accelerator.name])}
        >
          {t('providers:foundryLocal.accelerators.retry')}
        </Button>
      )
    }
    return <span className="text-xs">{t('providers:foundryLocal.accelerators.notPrepared')}</span>
  }

  return (
    <Card header={<Header />}>
      {answer.error && (
        <div className="mb-3 flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">{answer.error}</p>
          <Button size="sm" variant="outline" onClick={() => void read(true)}>
            {t('providers:foundryLocal.accelerators.checkAgain')}
          </Button>
        </div>
      )}
      {!answer.error && shown.length === 0 && (
        <p className="text-sm">{t('providers:foundryLocal.accelerators.none')}</p>
      )}
      {shown.map((accelerator) => {
        const reason = reasonOf(accelerator)
        return (
          // The row's own spacing and rule: `CardItem`'s `first:`/`last:` would see each row
          // alone in this wrapper and drop both, gluing one device line to the next name.
          <div
            key={accelerator.name}
            data-testid={`foundry-accelerator-${accelerator.name}`}
            className="border-b border-border/40 py-3 first:pt-0 last:border-none last:pb-0"
          >
            <CardItem
              // The status on the name's baseline, whatever the fonts: pinned to the top or centred,
              // the smaller text sat off the name's letters (by the font's metrics, on Windows more).
              className="items-baseline"
              title={LABELS[accelerator.execution_provider]}
              description={
                reason ? (
                  <span className="text-destructive">{reason}</span>
                ) : (
                  t('providers:foundryLocal.accelerators.device', { device: accelerator.device })
                )
              }
              actions={<div data-testid="foundry-accelerator-status">{status(accelerator)}</div>}
            />
          </div>
        )
      })}
      {/* While a prepare runs there is nothing to start: it covers every accelerator left. */}
      {unprepared.length > 0 && !busy && (
        <div className="mt-4 space-y-2">
          <p className="text-sm">{t('providers:foundryLocal.accelerators.sizeWarning')}</p>
          <Button
            size="sm"
            onClick={() => void prepare(unprepared.map((accelerator) => accelerator.name))}
          >
            {t('providers:foundryLocal.accelerators.prepare')}
          </Button>
        </div>
      )}
      {watching && <p className="mt-2 text-sm">{t('providers:foundryLocal.accelerators.busy')}</p>}
      {prepareError && <p className="mt-2 text-sm text-destructive">{prepareError}</p>}
    </Card>
  )
}

function Header() {
  const { t } = useTranslation()
  return (
    <div className="mb-4 space-y-1">
      <h1 className="text-foreground font-medium text-base">
        {t('providers:foundryLocal.accelerators.title')}
      </h1>
      <p className="text-sm">{t('providers:foundryLocal.accelerators.description')}</p>
    </div>
  )
}
