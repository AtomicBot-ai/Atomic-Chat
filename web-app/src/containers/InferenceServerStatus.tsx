/**
 * What the local inference server is doing, in words (ATO-535).
 *
 * Renderings of the same state, so they can never disagree:
 *
 *  - `InferenceServerStatusStrip` docks above the composer when a load failed.
 *    That is the surface Kostya was missing: when a reply does not come back,
 *    the app has to say why by itself. A load still in flight is told by the
 *    loading snackbar instead (ATO-530), which names the step and can cancel
 *    it — the strip saying "starting" underneath would be the same news twice.
 *  - `InferenceServerStatusLine` sits under the model row in the picker and is
 *    always there, so "loaded / not loaded" is readable at a glance instead of
 *    being inferred from the colour of a dot.
 */
import { IconAlertTriangle } from '@tabler/icons-react'
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { useAppState } from '@/hooks/useAppState'
import { useInferenceStatus } from '@/hooks/useInferenceStatus'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { type InferenceStatusPhase } from '@/lib/inference-status'
import { prettyModelName } from '@/lib/model-display-name'
import { cn } from '@/lib/utils'
import { describeModelLoadFailure, switchToModel } from '@/utils/switchModel'

type Wording = {
  /** One line saying what is happening. */
  headline: string
  /** What the user can or cannot do about it right now. */
  detail?: string
}

/** The failure's own wording, shared with the toast the same load raises. */
const useWording = (
  phase: InferenceStatusPhase,
  modelId: string | undefined
): Wording => {
  const { t } = useTranslation()
  const modelLoadError = useModelLoad((state) => state.modelLoadError)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)

  return useMemo(() => {
    const model = prettyModelName(modelId)
    switch (phase) {
      case 'starting':
        return {
          headline: t('common:inferenceStatus.starting', { model }),
          detail: t('common:inferenceStatus.startingDetail'),
        }
      case 'restarting':
        return {
          headline: t('common:inferenceStatus.restarting', { model }),
          detail: t('common:inferenceStatus.restartingDetail'),
        }
      case 'failed': {
        const failure = describeModelLoadFailure(modelLoadError, selectedProvider)
        return { headline: failure.title, detail: failure.description }
      }
      case 'ready':
        return { headline: t('common:inferenceStatus.ready', { model }) }
      case 'notLoaded':
        return { headline: t('common:inferenceStatus.notLoaded') }
      default:
        return { headline: '' }
    }
  }, [phase, modelId, modelLoadError, selectedProvider, t])
}

/**
 * The strip above the composer. Only a failure puts it there; the rest of the
 * time it takes no room at all.
 */
export function InferenceServerStatusStrip({
  className,
}: {
  className?: string
}) {
  const { t } = useTranslation()
  const status = useInferenceStatus()
  const wording = useWording(status.phase, status.modelId)
  const serviceHub = useServiceHub()
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const loadingModel = useAppState((state) => state.loadingModel)

  if (status.phase !== 'failed') return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-test-id="inference-server-status"
      data-phase={status.phase}
      className={cn(
        'mb-2 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs',
        className
      )}
    >
      <IconAlertTriangle
        size={14}
        className="mt-0.5 shrink-0 text-destructive"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{wording.headline}</p>
        {wording.detail && (
          <p className="text-muted-foreground mt-0.5">{wording.detail}</p>
        )}
      </div>
      {status.modelId && (
        <Button
          variant="link"
          size="sm"
          className="h-auto shrink-0 p-0 text-xs"
          disabled={loadingModel}
          onClick={() => {
            void switchToModel({
              modelId: status.modelId as string,
              providerName: selectedProvider,
              serviceHub,
            }).catch(() => {
              // The failure is already reported through the status itself.
            })
          }}
        >
          {t('common:inferenceStatus.retry')}
        </Button>
      )}
    </div>
  )
}

/** The always-present line under the model row in the picker. */
export function InferenceServerStatusLine({
  className,
}: {
  className?: string
}) {
  const status = useInferenceStatus()
  const wording = useWording(status.phase, status.modelId)

  if (status.phase === 'idle') return null

  return (
    <p
      data-test-id="inference-server-status-line"
      data-phase={status.phase}
      className={cn(
        'truncate text-xs',
        status.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        className
      )}
      title={wording.detail ?? wording.headline}
    >
      {wording.headline}
    </p>
  )
}
