import { memo } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getProviderTitle } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { ProvenanceMarker } from '@/lib/modelProvenance'

interface ModelProvenanceDividerProps {
  marker: ProvenanceMarker
}

/**
 * Quiet divider marking which model serves the messages that follow.
 * Shows the model id only; provider and backend build live in the tooltip.
 * All content comes from the persisted stamp, never from live settings, so
 * later model/backend changes cannot rewrite a thread's history.
 */
export const ModelProvenanceDivider = memo(
  ({ marker }: ModelProvenanceDividerProps) => {
    const { t } = useTranslation()
    const { kind, stamp } = marker

    return (
      <div
        className="flex items-center gap-3 my-4 select-none"
        data-testid="model-provenance-divider"
      >
        <img
          src="/images/transparent-logo.png"
          alt=""
          aria-hidden="true"
          className="size-4 shrink-0 object-contain opacity-50 dark:invert"
        />
        <div className="flex-1 border-t border-border/60" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground cursor-default shrink-0 max-w-[70%] truncate">
              {kind === 'served'
                ? t('common:modelProvenance.servedBy', {
                    model: stamp.modelId,
                  })
                : t('common:modelProvenance.switchedTo', {
                    model: stamp.modelId,
                  })}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            <div className="space-y-0.5 text-left">
              <div className="break-all">
                <span className="font-medium">
                  {t('common:modelProvenance.model')}:
                </span>{' '}
                {stamp.modelId}
              </div>
              <div>
                <span className="font-medium">
                  {t('common:modelProvenance.provider')}:
                </span>{' '}
                {getProviderTitle(stamp.providerId)}
              </div>
              {stamp.backend && (
                <div className="break-all">
                  <span className="font-medium">
                    {t('common:modelProvenance.backend')}:
                  </span>{' '}
                  {stamp.backend}
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
        <div className="flex-1 border-t border-border/60" />
        <img
          src="/images/transparent-logo.png"
          alt=""
          aria-hidden="true"
          className="size-4 shrink-0 object-contain opacity-50 dark:invert"
        />
      </div>
    )
  }
)

ModelProvenanceDivider.displayName = 'ModelProvenanceDivider'
