import { type ThreadMessage } from '@janhq/core'
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import {
  formatContextSize,
  useModelContextLength,
} from '@/hooks/useModelContextLength'
import { useTokensCount } from '@/hooks/useTokensCount'
import { cn } from '@/lib/utils'

interface ContextSizeControlProps {
  messages?: ThreadMessage[]
  additionalTokens?: number
  uploadedFiles?: Array<{
    name: string
    type: string
    size: number
    base64: string
    dataUrl: string
  }>
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toString()
}

type LatestTokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

function getLatestTokenUsage(messages: ThreadMessage[]): LatestTokenUsage {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue

    const metadata = message.metadata as Record<string, unknown> | undefined
    const usage = metadata?.usage as
      | {
          inputTokens?: unknown
          outputTokens?: unknown
          totalTokens?: unknown
        }
      | undefined
    const tokenSpeed = metadata?.tokenSpeed as
      | { tokenCount?: unknown }
      | undefined
    const outputValue = usage?.outputTokens ?? tokenSpeed?.tokenCount
    const outputTokens =
      typeof outputValue === 'number' && Number.isFinite(outputValue)
        ? Math.max(0, outputValue)
        : 0
    const totalTokens =
      typeof usage?.totalTokens === 'number' &&
      Number.isFinite(usage.totalTokens)
        ? Math.max(0, usage.totalTokens)
        : 0
    const inputTokens =
      typeof usage?.inputTokens === 'number' &&
      Number.isFinite(usage.inputTokens)
        ? Math.max(0, usage.inputTokens)
        : Math.max(0, totalTokens - outputTokens)

    return {
      inputTokens,
      outputTokens,
      totalTokens: Math.max(totalTokens, inputTokens + outputTokens),
    }
  }
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

export function ContextSizeControl({
  messages = [],
  additionalTokens = 0,
  uploadedFiles = [],
}: ContextSizeControlProps) {
  const tokenData = useTokensCount(messages, uploadedFiles)
  const latestUsage = getLatestTokenUsage(messages)
  const measuredTokens = tokenData.tokenCount + additionalTokens
  const totalTokens =
    measuredTokens > 0
      ? measuredTokens
      : latestUsage.totalTokens + additionalTokens
  const completionTokens = Math.min(totalTokens, latestUsage.outputTokens)
  const promptTokens = Math.max(0, totalTokens - completionTokens)
  const percentage = tokenData.maxTokens
    ? (totalTokens / tokenData.maxTokens) * 100
    : 0
  const isOverLimit = percentage > 100
  const progressTone =
    percentage >= 90
      ? 'bg-destructive'
      : percentage >= 70
        ? 'bg-orange-500'
        : 'bg-emerald-500'
  const {
    available,
    contextSetting,
    draft: draftContext,
    setDraft: setDraftContext,
    commit: handleContextChange,
    sliderMin,
    sliderMax,
    sliderStep,
  } = useModelContextLength()

  if (!available || !contextSetting) return null

  const percentageLabel = `${percentage.toFixed(1)}%`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-2 px-2 font-mono text-xs"
          aria-label={`Context usage: ${percentageLabel}`}
        >
          <span className={cn(isOverLimit && 'text-destructive')}>
            {percentageLabel}
          </span>
          <span className="relative size-4 shrink-0">
            <svg className="size-4 -rotate-90" viewBox="0 0 16 16">
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                className="text-muted-foreground"
              />
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 6}`}
                strokeDashoffset={`${2 * Math.PI * 6 * (1 - Math.min(percentage, 100) / 100)}`}
                className={cn(
                  'transition-all duration-500 ease-out',
                  isOverLimit ? 'stroke-destructive' : 'stroke-primary'
                )}
                style={{ transformOrigin: 'center' }}
              />
            </svg>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span
              className={cn(
                'text-lg font-semibold tabular-nums',
                isOverLimit ? 'text-destructive' : 'text-primary'
              )}
            >
              {percentageLabel}
            </span>
            <span className="font-mono text-sm text-muted-foreground">
              {formatTokenCount(totalTokens)} /{' '}
              {formatTokenCount(tokenData.maxTokens || 0)}
            </span>
          </div>
          <Progress
            aria-label="Context usage"
            value={Math.min(percentage, 100)}
            className="h-1.5 bg-muted"
            indicatorClassName={progressTone}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <IconArrowUp className="size-3.5" stroke={1.75} />
              <span>Input</span>
            </span>
            <span className="font-mono text-foreground">
              {formatTokenCount(promptTokens)}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <IconArrowDown className="size-3.5" stroke={1.75} />
              <span>Output</span>
            </span>
            <span className="font-mono text-foreground">
              {formatTokenCount(completionTokens)}
            </span>
          </div>
        </div>
        <div className="space-y-3 border-t border-border pt-3">
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium">{contextSetting.title}</div>
              <div className="font-mono text-xs tabular-nums">
                {formatContextSize(draftContext)}
              </div>
            </div>
            {contextSetting.description && (
              <div className="text-xs text-muted-foreground">
                {contextSetting.description}
              </div>
            )}
          </div>
          <Slider
            aria-label={contextSetting.title}
            className="w-full"
            value={[Math.min(Math.max(draftContext, sliderMin), sliderMax)]}
            min={sliderMin}
            max={sliderMax}
            step={sliderStep}
            onValueChange={([value]) => setDraftContext(value)}
            onValueCommit={([value]) => handleContextChange(value)}
          />
          <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
            <span>{formatContextSize(sliderMin)}</span>
            <span>{formatContextSize(sliderMax)}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
