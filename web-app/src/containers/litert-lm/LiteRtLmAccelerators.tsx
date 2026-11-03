import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/utils'
import { liteRtLmAccelerators, prepareLiteRtLmAccelerators } from '@/services/litert-lm/core'
import type {
  LiteRtLmAccelerator,
  LiteRtLmAccelerators as AcceleratorsAnswer,
  LiteRtLmAcceleratorsEvent,
} from '@/services/litert-lm/types'

import { useLiteRtLmInstallStore } from './install-store'

/** The core's `litert-lm:accelerators`, as the relay names it. */
const PREPARE_EVENT = 'atomic-core://litert-lm:accelerators'

/** How the NPU generation reads on the page. */
const NPU_LABELS: Record<string, string> = {
  'intel-lnl': 'Lunar Lake',
  'intel-ptl': 'Panther Lake',
}

/** How long a prepare this page follows may stay silent before Prepare is offered again. */
const WATCH_QUIET_MS = 30_000

type Step = Pick<LiteRtLmAcceleratorsEvent, 'stage' | 'fraction' | 'reason'>

const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(error)
}

/**
 * The Intel NPU block of the LiteRT-LM provider page (spec `litert-lm-desktop`, "Страница провайдера
 * ставит движок и готовит NPU"). The core lists `openvino` only on a Windows x64 host with an Intel
 * NPU LiteRT-LM files target; everywhere else the list is empty and the block is not shown.
 *
 * OpenVINO (about 85 MB) is downloaded only when the person asks: once by itself right after they
 * installed or updated the engine on this page, or with Prepare / Retry here. Progress comes as the
 * core's `litert-lm:accelerators` events and is followed while the block is open, whoever started
 * the prepare: one still running when the page is opened again shows its progress here, and a
 * Prepare the core refuses as busy turns into following it. A failure keeps its reason and a retry.
 */
export function LiteRtLmAccelerators() {
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

  const read = useCallback(async () => {
    try {
      setAnswer(await liteRtLmAccelerators())
      setLoadError(null)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  // Followed for as long as the block is open, not only during a prepare this page started.
  const mounted = useRef(true)
  const unlisten = useRef<(() => void) | null>(null)
  const follow = useCallback(async () => {
    if (unlisten.current) return
    const stop = await listen<LiteRtLmAcceleratorsEvent>(PREPARE_EVENT, (event) => {
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

  /** Read what is prepared now, then forget the steps it replaces. */
  const settle = useCallback(async () => {
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
      const result = await prepareLiteRtLmAccelerators(names)
      const failed = result.accelerators.find((accelerator) => !accelerator.prepared)
      if (failed) {
        setSteps((current) => ({
          ...current,
          [failed.name]: { stage: 'failed', fraction: null, reason: failed.reason },
        }))
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code
      if (code === 'ENGINE_INSTALL_IN_PROGRESS') busy = true
      else setPrepareError(t('providers:liteRtLm.accelerators.prepareFailed', { message: messageOf(error) }))
    } finally {
      setPreparing(false)
      if (busy) setWatching(true)
      else {
        await read()
        setInFlight([])
      }
    }
  }

  const stepActive = (step: Step | undefined) => step?.stage === 'started' || step?.stage === 'downloading'
  const anyActive = Object.values(steps).some(stepActive)

  // Following someone else's prepare: over once every accelerator it was waited for has reported
  // its end, or after a quiet spell, so Prepare comes back instead of the page waiting forever.
  useEffect(() => {
    if (!watching || anyActive) return
    const ended = inFlight.every((name) => steps[name]?.stage === 'done' || steps[name]?.stage === 'failed')
    const timer = setTimeout(() => void settle(), ended ? 0 : WATCH_QUIET_MS)
    return () => clearTimeout(timer)
  }, [watching, anyActive, inFlight, steps, settle])

  const busy = preparing || watching || anyActive

  // Right after an install or update from this page: OpenVINO, once, where the core offers it.
  const justInstalled = useLiteRtLmInstallStore((state) => state.justInstalled)
  useEffect(() => {
    if (!answer?.installed || !justInstalled || answer.build !== justInstalled || busy) return
    useLiteRtLmInstallStore.setState({ justInstalled: null })
    const names = answer.accelerators
      .filter((accelerator) => !accelerator.prepared)
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
  if (answer.error) {
    return (
      <Card header={<Header />}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">{answer.error}</p>
          <Button size="sm" variant="outline" onClick={() => void read()}>
            {t('providers:liteRtLm.accelerators.checkAgain')}
          </Button>
        </div>
      </Card>
    )
  }
  // No Intel NPU LiteRT-LM targets here (macOS, Linux, most Windows machines): no block at all.
  if (answer.accelerators.length === 0) return null

  // A step the core reported wins over the answer read before it.
  const isPrepared = (accelerator: LiteRtLmAccelerator) => {
    const stage = steps[accelerator.name]?.stage
    return stage === 'done' || (accelerator.prepared && stage !== 'failed')
  }
  const reasonOf = (accelerator: LiteRtLmAccelerator) => {
    const step = steps[accelerator.name]
    if (step?.stage === 'failed') return step.reason ?? accelerator.reason ?? ''
    return step || isPrepared(accelerator) ? undefined : accelerator.reason
  }
  const unprepared = answer.accelerators.filter((accelerator) => !isPrepared(accelerator))
  const downloadBytes = unprepared.reduce((sum, accelerator) => sum + accelerator.size_bytes, 0)

  const status = (accelerator: LiteRtLmAccelerator) => {
    const step = steps[accelerator.name]
    if (stepActive(step)) {
      return typeof step?.fraction === 'number' ? (
        <div className="flex w-40 flex-col items-end gap-1">
          <span className="text-xs">
            {t('providers:liteRtLm.accelerators.downloading', {
              percent: Math.round(step.fraction * 100),
            })}
          </span>
          <Progress value={step.fraction * 100} className="h-1" />
        </div>
      ) : (
        <span className="text-xs">{t('providers:liteRtLm.accelerators.preparing')}</span>
      )
    }
    if (isPrepared(accelerator)) {
      return (
        <span className="text-xs text-emerald-600 dark:text-emerald-400">
          {t('providers:liteRtLm.accelerators.ready')}
        </span>
      )
    }
    if (!step && inFlight.includes(accelerator.name)) {
      return <span className="text-xs">{t('providers:liteRtLm.accelerators.preparing')}</span>
    }
    if (reasonOf(accelerator) !== undefined) {
      return (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void prepare([accelerator.name])}>
          {t('providers:liteRtLm.accelerators.retry')}
        </Button>
      )
    }
    return <span className="text-xs">{t('providers:liteRtLm.accelerators.notPrepared')}</span>
  }

  return (
    <Card header={<Header />}>
      {answer.accelerators.map((accelerator) => {
        const reason = reasonOf(accelerator)
        return (
          <div
            key={accelerator.name}
            data-testid={`litert-accelerator-${accelerator.name}`}
            className="border-b border-border/40 py-3 first:pt-0 last:border-none last:pb-0"
          >
            <CardItem
              className="items-baseline"
              title={t('providers:liteRtLm.accelerators.openvino', { version: accelerator.version })}
              description={
                reason ? (
                  <span className="text-destructive">{reason}</span>
                ) : (
                  t('providers:liteRtLm.accelerators.detail', {
                    npu: NPU_LABELS[answer.npu ?? ''] ?? answer.npu ?? accelerator.device,
                    size: formatBytes(accelerator.size_bytes),
                  })
                )
              }
              actions={<div data-testid="litert-accelerator-status">{status(accelerator)}</div>}
            />
          </div>
        )
      })}
      {unprepared.length > 0 && !busy && (
        <div className="mt-4">
          <Button size="sm" onClick={() => void prepare(unprepared.map((accelerator) => accelerator.name))}>
            {t('providers:liteRtLm.accelerators.prepare', { size: formatBytes(downloadBytes) })}
          </Button>
        </div>
      )}
      {watching && <p className="mt-2 text-sm">{t('providers:liteRtLm.accelerators.busy')}</p>}
      {prepareError && <p className="mt-2 text-sm text-destructive">{prepareError}</p>}
    </Card>
  )
}

function Header() {
  const { t } = useTranslation()
  return (
    <div className="mb-4 space-y-1">
      <h1 className="text-foreground font-medium text-base">{t('providers:liteRtLm.accelerators.title')}</h1>
      <p className="text-sm">{t('providers:liteRtLm.accelerators.description')}</p>
    </div>
  )
}
