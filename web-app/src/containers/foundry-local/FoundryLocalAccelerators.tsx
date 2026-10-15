import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useState } from 'react'

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
 * only a start and an end for Windows ML. One accelerator failing does not stop the others; a
 * failed one keeps its reason and gets its own retry. An accelerator no variant runs on
 * (TensorRT-RTX, `execution_provider: null`) is not shown and never prepared.
 */
export function FoundryLocalAccelerators() {
  const { t } = useTranslation()
  const [answer, setAnswer] = useState<AcceleratorsAnswer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [steps, setSteps] = useState<Record<string, Step>>({})
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

  const prepare = async (names: string[]) => {
    if (names.length === 0 || preparing) return
    setPreparing(true)
    setPrepareError(null)
    setSteps({})
    let unlisten: (() => void) | undefined
    try {
      // Registered before the call: the core reports steps before it answers.
      unlisten = await listen<FoundryLocalAcceleratorsEvent>(PREPARE_EVENT, (event) => {
        const { accelerator, stage, fraction, reason } = event.payload
        setSteps((current) => ({ ...current, [accelerator]: { stage, fraction, reason } }))
      })
      await prepareFoundryLocalAccelerators(names)
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code
      setPrepareError(
        code === 'ENGINE_INSTALL_IN_PROGRESS'
          ? t('providers:foundryLocal.accelerators.busy')
          : t('providers:foundryLocal.accelerators.prepareFailed', { message: messageOf(error) })
      )
    } finally {
      unlisten?.()
      setPreparing(false)
      setSteps({})
      // The core forgets its probe after a prepare: this read shows what the library registered.
      await read()
    }
  }

  // Right after an install from this page: every accelerator a variant runs on, once.
  const justInstalled = useFoundryLocalInstallStore((state) => state.justInstalled)
  useEffect(() => {
    if (!answer?.installed || !justInstalled || answer.build !== justInstalled || preparing) return
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
  const unprepared = shown.filter((accelerator) => !accelerator.prepared)

  const status = (accelerator: FoundryLocalAccelerator) => {
    const step = steps[accelerator.name]
    if (step && (step.stage === 'started' || step.stage === 'downloading')) {
      return typeof step.fraction === 'number' ? (
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
    if (accelerator.prepared) {
      return (
        <span className="text-xs text-emerald-600 dark:text-emerald-400">
          {t('providers:foundryLocal.accelerators.ready')}
        </span>
      )
    }
    if (accelerator.reason) {
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={preparing}
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
      {shown.map((accelerator) => (
        <div key={accelerator.name} data-testid={`foundry-accelerator-${accelerator.name}`}>
          <CardItem
            title={LABELS[accelerator.execution_provider]}
            description={
              accelerator.reason && !accelerator.prepared ? (
                <span className="text-destructive">{accelerator.reason}</span>
              ) : (
                t('providers:foundryLocal.accelerators.device', { device: accelerator.device })
              )
            }
            actions={status(accelerator)}
          />
        </div>
      ))}
      {unprepared.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm">{t('providers:foundryLocal.accelerators.sizeWarning')}</p>
          <Button
            size="sm"
            disabled={preparing}
            onClick={() => void prepare(unprepared.map((accelerator) => accelerator.name))}
          >
            {t('providers:foundryLocal.accelerators.prepare')}
          </Button>
        </div>
      )}
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
