/**
 * The status dot before the model's name in the composer pill (ATO-530).
 *
 * It says what the engine is doing with the selected local model — a green
 * check when loaded, a spinner while loading, red when the load failed,
 * hollow when nothing is in memory — and doubles as the way out of memory:
 * hovering a loaded model turns the dot into a red power icon, and one click
 * unloads it. On a load in flight the same click stops the load, so closing
 * the loading snackbar never takes the Cancel away with it.
 *
 * An unload is recorded like a Stop, so the composer does not load the model
 * straight back. Its selection is cleared; picking it again loads it.
 */
import { useState, type ReactElement } from 'react'

import { IconCircleCheck, IconCircleX, IconLoader2 } from '@tabler/icons-react'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useInferenceStatus } from '@/hooks/useInferenceStatus'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { prettyModelName } from '@/lib/model-display-name'
import { cn } from '@/lib/utils'
import { cancelModelLoad, unloadModelByUser } from '@/utils/switchModel'

export function ActiveModelIndicator({ className }: { className?: string }) {
  const { t } = useTranslation()
  const status = useInferenceStatus()
  const serviceHub = useServiceHub()
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const [unloading, setUnloading] = useState(false)

  if (status.phase === 'idle' || !status.modelId) return null
  const modelId = status.modelId
  const model = prettyModelName(modelId)

  if (status.phase === 'failed' || status.phase === 'notLoaded') {
    const label =
      status.phase === 'failed'
        ? t('common:modelLoad.indicator.failed')
        : t('common:modelLoad.indicator.notLoaded')
    return (
      <Hint label={label}>
        <span
          role="img"
          aria-label={label}
          data-testid="active-model-indicator"
          data-status={status.phase}
          className={cn(
            'flex size-4 shrink-0 items-center justify-center',
            className
          )}
        >
          <span
            className={cn(
              'size-2 rounded-full',
              status.phase === 'failed'
                ? 'bg-destructive'
                : 'border border-muted-foreground'
            )}
          />
        </span>
      </Hint>
    )
  }

  const loading = status.phase === 'starting' || status.phase === 'restarting'
  const busy = unloading || (loading && status.cancelling)
  const state = unloading ? 'unloading' : loading ? 'loading' : 'ready'
  const summary = {
    unloading: t('common:modelLoad.indicator.unloading', { model }),
    loading: t('common:modelLoad.indicator.loading', { model }),
    ready: t('common:modelLoad.indicator.loaded', { model }),
  }[state]
  const action = loading
    ? t('common:modelLoad.indicator.stopLoading')
    : t('common:modelLoad.indicator.unload')

  const onClick = async () => {
    if (busy) return
    if (loading) {
      await cancelModelLoad(serviceHub)
      return
    }
    setUnloading(true)
    try {
      await unloadModelByUser({
        modelId,
        providerName: selectedProvider,
        serviceHub,
      })
    } catch (error) {
      console.error('[ActiveModelIndicator] unload failed:', error)
    } finally {
      setUnloading(false)
    }
  }

  return (
    <Hint label={busy ? summary : `${summary} · ${action}`}>
      <button
        type="button"
        aria-label={busy ? summary : `${summary}. ${action}`}
        data-testid="active-model-indicator"
        data-status={state}
        disabled={busy}
        onClick={() => void onClick()}
        className={cn(
          'group/dot flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default',
          className
        )}
      >
        {busy || loading ? (
          <IconLoader2
            size={14}
            className={cn(
              'animate-spin text-muted-foreground',
              !busy && 'group-hover/dot:hidden group-focus-visible/dot:hidden'
            )}
          />
        ) : (
          <IconCircleCheck
            size={14}
            stroke={1.75}
            className="text-emerald-600 group-hover/dot:hidden group-focus-visible/dot:hidden dark:text-emerald-400"
          />
        )}
        {!busy && (
          <IconCircleX
            size={14}
            stroke={1.75}
            aria-hidden="true"
            className="hidden text-destructive group-hover/dot:block group-focus-visible/dot:block"
          />
        )}
      </button>
    </Hint>
  )
}

function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export default ActiveModelIndicator
