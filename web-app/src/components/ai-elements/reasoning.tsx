/* eslint-disable react-refresh/only-export-components */
import { useControllableState } from '@radix-ui/react-use-controllable-state'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { IconBulb } from '@tabler/icons-react'
import { ChevronDownIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Streamdown } from 'streamdown'
import { Shimmer } from './shimmer'

type ReasoningContextValue = {
  isStreaming: boolean
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  duration: number | undefined
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null)

export const useReasoning = () => {
  const context = useContext(ReasoningContext)
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning')
  }
  return context
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  duration?: number
}

const MS_IN_S = 1000
// While a turn runs the panel is 128px tall — about eight lines — so the
// window only has to cover scroll-back, not the trace. Cost of one streamed
// delta at a 60k-character trace, measured in WebKit: 314ms for live
// Markdown against 1ms for a plain-text window. Any bounded window fixes the
// growth; this one keeps the per-frame layout down to a screenful of lines.
const STREAMING_REASONING_VISIBLE_CHARS = 4_000
const STREAMING_REASONING_TRUNCATED_PREFIX =
  '… earlier reasoning will appear when generation completes …\n\n'

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    })
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      defaultProp: undefined,
    })

    const [startTime, setStartTime] = useState<number | null>(null)
    const wasStreamingRef = useRef(isStreaming)

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          setStartTime(Date.now())
        }
      } else if (startTime !== null) {
        setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S))
        setStartTime(null)
      }
    }, [isStreaming, startTime, setDuration])

    // The panel auto-closes when the turn ends. Committing that only from the
    // effect below would first render the finished trace as Markdown and then
    // unmount it on the very next commit — 657ms of frozen UI on an
    // 80k-character trace in WebKit, for a subtree nobody ever sees. Deriving
    // the closed state here keeps that render from happening at all; the
    // effect still commits it.
    const justFinishedStreaming = wasStreamingRef.current && !isStreaming
    const openState = justFinishedStreaming ? false : isOpen

    // Auto-close when streaming ends (only when transitioning from streaming to not streaming)
    useEffect(() => {
      if (wasStreamingRef.current && !isStreaming) {
        // Streaming just ended, auto-close
        setIsOpen(false)
      }
      wasStreamingRef.current = isStreaming
    }, [isStreaming, setIsOpen])

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen)
    }

    const contextValue = useMemo(
      () => ({
        isStreaming,
        isOpen: openState,
        setIsOpen,
        duration,
      }),
      [isStreaming, openState, setIsOpen, duration]
    )

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn('not-prose mb-4', className)}
          onOpenChange={handleOpenChange}
          open={openState}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    )
  }
)

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode
}

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>Thinking...</Shimmer>
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>
  }
  return <p>Thought for {duration} seconds</p>
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning()

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground',
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <IconBulb className="size-4" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn(
                'size-4 transition-transform',
                isOpen ? 'rotate-180' : 'rotate-0'
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    )
  }
)

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string
  isStreaming?: boolean
}

export const ReasoningContent = memo(
  ({
    className,
    children,
    isStreaming = false,
    ...props
  }: ReasoningContentProps) => {
    const { isOpen } = useReasoning()
    // Radix keeps the content mounted for the collapse animation, so a panel
    // that is on its way closed would still pay for the full Markdown parse.
    // Only a panel a reader can actually read is worth parsing.
    const showMarkdown = !isStreaming && isOpen
    const plainText =
      children.length > STREAMING_REASONING_VISIBLE_CHARS
        ? STREAMING_REASONING_TRUNCATED_PREFIX +
          children.slice(-STREAMING_REASONING_VISIBLE_CHARS)
        : children

    return (
      <CollapsibleContent
        className={cn(
          'mt-4 text-sm relative',
          'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
          className
        )}
        {...props}
      >
        {/* Streamdown's own utility classes (list-inside, pl-6, ...) are not
        emitted by this build (Tailwind doesn't scan node_modules), so markdown
        here must be styled by the app's `.markdown` stylesheet — without it,
        list markers fall back to `outside` with zero padding and overlap the
        dotted border. */}
        <div className="markdown ml-2 pl-4 border-l-2 border-dotted">
          {showMarkdown ? (
            <Streamdown animate={false} {...props}>
              {children}
            </Streamdown>
          ) : (
            <div
              className="whitespace-pre-wrap wrap-break-word"
              data-streaming-reasoning
              dir="auto"
            >
              {plainText}
            </div>
          )}
        </div>
      </CollapsibleContent>
    )
  }
)

Reasoning.displayName = 'Reasoning'
ReasoningTrigger.displayName = 'ReasoningTrigger'
ReasoningContent.displayName = 'ReasoningContent'
