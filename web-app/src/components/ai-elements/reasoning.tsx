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

type ReasoningContextValue = {
  isStreaming: boolean
  isOpen: boolean
  preferPlainText: boolean
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
const STREAMING_REASONING_FORMAT_LIMIT = 20_000

function normalizeReasoningMarkdown(value: string): string {
  // Some local chat templates concatenate separately-bolded status lines as
  // `**First****Second**`. Markdown treats that boundary inconsistently while
  // streaming. Preserve the words, but make each status a real paragraph.
  return value.replace(/\*\*\*\*/g, '**\n\n**')
}

function StreamingReasoningText({ children }: { children: string }) {
  const pieces: ReactNode[] = []
  const pattern = /\*\*([^*]+)\*\*/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(children))) {
    if (match.index > cursor) pieces.push(children.slice(cursor, match.index))
    pieces.push(
      <strong key={`${match.index}-${match[1]}`} className="font-semibold">
        {match[1]}
      </strong>
    )
    cursor = match.index + match[0].length
  }
  if (cursor < children.length) pieces.push(children.slice(cursor))
  return <>{pieces}</>
}

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
      defaultProp: isStreaming ? 1 : undefined,
    })

    const [startTime, setStartTime] = useState<number | null>(() =>
      isStreaming ? performance.now() : null
    )
    const streamedThisMountRef = useRef(isStreaming)
    if (isStreaming) streamedThisMountRef.current = true
    const [readerReopened, setReaderReopened] = useState(false)

    // Use elapsed monotonic time, so wall-clock corrections cannot freeze or
    // jump the timer while the enclosing turn moves through tools and waits.
    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          setStartTime(performance.now())
          setDuration((current) => Math.max(current ?? 0, 1))
          return
        }
        const update = () => {
          const elapsed = Math.max(
            1,
            Math.ceil((performance.now() - startTime) / MS_IN_S)
          )
          setDuration((current) => Math.max(current ?? 0, elapsed))
        }
        update()
        const timer = window.setInterval(update, MS_IN_S)
        return () => window.clearInterval(timer)
      }
      if (startTime !== null) {
        const elapsed = Math.max(
          1,
          Math.ceil((performance.now() - startTime) / MS_IN_S)
        )
        setDuration((current) => Math.max(current ?? 0, elapsed))
        setStartTime(null)
      }
    }, [isStreaming, startTime, setDuration])

    const handleOpenChange = (newOpen: boolean) => {
      if (!isStreaming && newOpen && !isOpen) setReaderReopened(true)
      setIsOpen(newOpen)
    }

    const contextValue = useMemo(
      () => ({
        isStreaming,
        isOpen,
        // A live trace stays as the lightweight streaming render after the
        // model finishes. Keeping it open preserves the page height and avoids
        // a scroll jump; closing and opening it explicitly opts into Markdown.
        preferPlainText:
          streamedThisMountRef.current && !isStreaming && !readerReopened,
        setIsOpen,
        duration,
      }),
      [isStreaming, isOpen, readerReopened, setIsOpen, duration]
    )

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn('not-prose mb-4', className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    )
  }
)

/** Own the viewport geometry with the same closed state Radix receives.
 * A finished, closing panel must never spend a frame at its trace's height.
 */
export const ReasoningViewport = ({
  className,
  ...props
}: ComponentProps<'div'>) => {
  const { isOpen } = useReasoning()
  return (
    <div
      {...props}
      data-reasoning-viewport
      data-state={isOpen ? 'open' : 'closed'}
      data-bounded={!isOpen}
      className={cn(
        'relative w-full min-w-0 text-sm transition-[margin] duration-150 ease-out motion-reduce:transition-none',
        isOpen
          ? 'mt-2 h-auto overflow-visible'
          : 'mt-0 max-h-0 overflow-hidden',
        className
      )}
    />
  )
}

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode
}

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming) {
    return `Thinking for ${duration ?? 1}s…`
  }
  if (duration === undefined) {
    return 'Thought for a few seconds'
  }
  return `Thought for ${duration}s`
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
          'flex min-h-6 w-full min-w-0 items-center gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground',
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <IconBulb className="size-[18px] shrink-0" stroke={1.8} />
            <span className="inline-flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate">
                {getThinkingMessage(isStreaming, duration)}
              </span>
              <ChevronDownIcon
                className={cn(
                  'size-4 shrink-0 transition-transform',
                  isOpen ? 'rotate-180' : 'rotate-0'
                )}
              />
            </span>
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
    const { isOpen, preferPlainText } = useReasoning()
    // Radix keeps the content mounted for the collapse animation, so a panel
    // that is on its way closed would still pay for the full Markdown parse.
    // Only a panel a reader can actually read is worth parsing.
    const showMarkdown = !isStreaming && isOpen && !preferPlainText
    const normalizedChildren = normalizeReasoningMarkdown(children)
    const formatStreaming =
      normalizedChildren.length <= STREAMING_REASONING_FORMAT_LIMIT

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
        <div className="markdown ml-2 border-l border-border/60 pl-4">
          {showMarkdown ? (
            <Streamdown animate={false} {...props}>
              {normalizedChildren}
            </Streamdown>
          ) : (
            <div
              className="whitespace-pre-wrap wrap-break-word"
              data-streaming-reasoning
              dir="auto"
            >
              {formatStreaming ? (
                <StreamingReasoningText>
                  {normalizedChildren}
                </StreamingReasoningText>
              ) : (
                normalizedChildren
              )}
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
