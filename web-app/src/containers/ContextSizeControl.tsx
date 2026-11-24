import { useState } from 'react'
import { type ThreadMessage } from '@janhq/core'
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsMinimize,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { EngineContextEditor } from './EngineContextEditor'
import { engineContext } from '@/lib/engine-context'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  formatContextSize,
  useModelContextLength,
} from '@/hooks/useModelContextLength'
import { useTokensCount } from '@/hooks/useTokensCount'
import { useThreads } from '@/hooks/useThreads'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useAppState } from '@/hooks/useAppState'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  COMPACTION_METADATA_KEY,
  appliedCompaction,
  compactsHistory,
  hasCompactableHistory,
  readThreadCompaction,
} from '@/lib/context-compaction'
import { contextRoutesAbsent } from '@/lib/core-context'
import { useChatSessions } from '@/stores/chat-session-store'

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

/**
 * "Compact history": summarize the current thread's older messages now, with
 * the selected local model; they stay on the page above a divider. Offered
 * while the thread has history older than its latest turn, and off while a
 * request runs or the history is already being compacted.
 */
function CompactHistoryRow({ messages }: { messages: ThreadMessage[] }) {
  const { t } = useTranslation()
  const providerId = useModelProvider((state) => state.selectedProvider)
  const threadId = useThreads((state) => state.currentThreadId)
  const rawCompaction = useThreads((state) =>
    threadId
      ? state.threads[threadId]?.metadata?.[COMPACTION_METADATA_KEY]
      : undefined
  )
  const requestActive = useChatSessions((state) =>
    threadId ? state.requestActive[threadId] === true : false
  )
  const contextBusy = useAppState(
    (state) =>
      state.contextActivity.phase !== null &&
      (state.contextActivity.threadId === undefined ||
        state.contextActivity.threadId === threadId)
  )
  const [compacting, setCompacting] = useState(false)

  if (!threadId || !compactsHistory(providerId)) return null
  const transport = useChatSessions.getState().sessions[threadId]?.transport
  const compaction = appliedCompaction(
    messages,
    readThreadCompaction({ [COMPACTION_METADATA_KEY]: rawCompaction })
  )
  const canCompact =
    transport !== undefined &&
    !contextRoutesAbsent('compact') &&
    hasCompactableHistory(messages, [
      compaction?.upToMessageId,
      transport.getHistoryStart(),
    ])

  const compact = async () => {
    const session = useChatSessions.getState().sessions[threadId]
    if (!session) return
    const sessions = useChatSessions.getState()
    setCompacting(true)
    // The composer waits while the summary is made: a message sent meanwhile
    // would go out with the history being replaced.
    sessions.setRequestActive(threadId, true)
    useAppState.getState().setContextCompacting({ threadId })
    try {
      const outcome = await session.transport.compactHistory({
        messages: session.chat.messages,
      })
      if (outcome.ok) {
        toast.success(
          t('chat:contextCompaction.done', {
            count: outcome.compaction.summarizedCount,
          })
        )
      } else if (outcome.reason === 'nothing') {
        toast.info(t('chat:contextCompaction.nothing'))
      } else {
        toast.error(t('chat:contextCompaction.failed'))
      }
    } finally {
      useAppState.getState().clearContextActivity(threadId)
      useChatSessions.getState().setRequestActive(threadId, false)
      setCompacting(false)
    }
  }

  return (
    <div
      className="flex items-center justify-between gap-3 border-t border-border pt-4"
      data-testid="context-compact-row"
    >
      <p className="min-w-0 text-sm leading-snug text-muted-foreground">
        {t('chat:contextCompaction.compactHint')}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={!canCompact || requestActive || contextBusy || compacting}
        onClick={() => void compact()}
      >
        <IconArrowsMinimize aria-hidden="true" className="size-4" />
        {t('chat:contextCompaction.compact')}
      </Button>
    </div>
  )
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
  const {
    available,
    provider,
    selectedModel,
    strataMax,
    deviceLimit,
    contextSetting,
    draft: draftContext,
    setDraft: setDraftContext,
    commit: handleContextChange,
    sliderMin,
    sliderMax,
    sliderStep,
    fitAvailable,
    fitEnabled,
    setFit,
  } = useModelContextLength()
  const engine = engineContext(provider, selectedModel, strataMax)
  // The window the core measured the session at comes first: it is the one
  // the engine serves, also where the setting says Auto.
  const capacity =
    tokenData.windowTokens ?? (engine ? engine.capacity : tokenData.maxTokens)
  const percentage = capacity ? (totalTokens / capacity) * 100 : 0
  const isOverLimit = percentage > 100
  const progressTone =
    percentage >= 90
      ? 'bg-destructive'
      : percentage >= 70
        ? 'bg-orange-500'
        : 'bg-emerald-500'
  const { t } = useTranslation()

  // An engine with no context setting of the app's (Foundry Local, Apple
  // Foundation Models) still shows its usage once the core measured it.
  const measuredOnly = tokenData.windowTokens !== undefined
  if (!engine && (!available || !contextSetting) && !measuredOnly) return null

  const unknownCapacity = engine?.configured ? '—' : t('common:auto')
  const percentageLabel =
    engine && !capacity ? unknownCapacity : `${percentage.toFixed(1)}%`

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
          {(!engine || capacity) && (
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
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={16}
        className="w-96 max-w-[calc(100vw-2rem)] space-y-4 p-4"
        data-testid="context-size-popover"
      >
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span
              className={cn(
                'text-xl font-semibold tabular-nums',
                isOverLimit ? 'text-destructive' : 'text-primary'
              )}
            >
              {percentageLabel}
            </span>
            <span className="font-mono text-sm text-muted-foreground">
              {formatTokenCount(totalTokens)} /{' '}
              {engine && !capacity
                ? unknownCapacity
                : formatTokenCount(capacity || 0)}
            </span>
          </div>
          {(!engine || capacity) && (
            <Progress
              aria-label="Context usage"
              value={Math.min(percentage, 100)}
              className="h-1.5 bg-muted"
              indicatorClassName={progressTone}
            />
          )}
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
        <CompactHistoryRow messages={messages} />
        {engine && provider && selectedModel ? (
          <EngineContextEditor
            key={JSON.stringify([provider.provider, selectedModel.id])}
            providerId={provider.provider}
            modelId={selectedModel.id}
            context={engine}
          />
        ) : (
          contextSetting && (
            <div className="space-y-4 border-t border-border pt-4">
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium">
                    {contextSetting.title}
                  </div>
                  <div className="font-mono text-sm tabular-nums">
                    {formatContextSize(draftContext)}
                  </div>
                </div>
                {contextSetting.description && !fitEnabled && (
                  <div className="mt-0.5 text-sm leading-snug text-muted-foreground">
                    {contextSetting.description}
                  </div>
                )}
              </div>
              {fitAvailable && (
                <label className="flex items-start justify-between gap-4 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {t('assistants:contextSizeFit')}
                    </span>
                    <span
                      className="mt-0.5 block leading-snug text-muted-foreground"
                      data-testid="context-size-fit-description"
                    >
                      {fitEnabled
                        ? t('assistants:contextSizeFitOn')
                        : t('assistants:contextSizeFitHint')}
                    </span>
                  </span>
                  <Switch
                    className="mt-0.5 shrink-0"
                    aria-label={t('assistants:contextSizeFit')}
                    checked={fitEnabled}
                    onCheckedChange={setFit}
                  />
                </label>
              )}
              {/* Under fit the slider is not ignored silently, as it was: it is
              disabled, and the number above it is the one the engine chose. */}
              <Slider
                aria-label={contextSetting.title}
                className="w-full"
                disabled={fitEnabled}
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
              {deviceLimit && (
                <p
                  className="text-sm leading-snug text-muted-foreground"
                  data-testid="context-size-device-max"
                >
                  {deviceLimit.trainedCtx
                    ? t('assistants:contextSizeDeviceMaxBelowTrained', {
                        size: formatContextSize(deviceLimit.maxCtx),
                        trained: formatContextSize(deviceLimit.trainedCtx),
                      })
                    : t('assistants:contextSizeDeviceMax', {
                        size: formatContextSize(deviceLimit.maxCtx),
                      })}
                </p>
              )}
            </div>
          )
        )}
      </PopoverContent>
    </Popover>
  )
}
