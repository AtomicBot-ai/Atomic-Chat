import { useControllableState } from '@radix-ui/react-use-controllable-state'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import { ChevronDownIcon, Loader2, WrenchIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import {
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { StickToBottom } from 'use-stick-to-bottom'
import { CodeBlock, highlightCode } from '../code-block'
import { guessBlockLanguage, splitToolInput } from '@/lib/toolParamPreview'

type ToolContextValue = {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  state: ToolUIPart['state']
}

const ToolContext = createContext<ToolContextValue | null>(null)

export const useTool = () => {
  const context = useContext(ToolContext)
  if (!context) {
    throw new Error('Tool components must be used within Tool')
  }
  return context
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  className?: string
  state: ToolUIPart['state']
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export const Tool = memo(
  ({
    className,
    state,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ToolProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    })

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen)
    }

    return (
      <ToolContext.Provider value={{ isOpen, setIsOpen, state }}>
        <Collapsible
          className={cn('not-prose', className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ToolContext.Provider>
    )
  }
)

export type ToolHeaderProps = {
  title?: string
  subtitle?: string
  state: ToolUIPart['state']
  type: ToolUIPart['type']
  className?: string
}

const getStatusText = (status: ToolUIPart['state'], toolName: string) => {
  const isRunning = status === 'input-streaming' || status === 'input-available'
  // @ts-expect-error state only available in AI SDK v6
  const hasError = status === 'output-error' || status === 'output-denied'

  if (isRunning) {
    return `Running ${toolName.replaceAll('_', ' ')}...`
  }
  if (hasError) {
    return `${toolName.replaceAll('_', ' ')} failed`
  }
  return `Used ${toolName.replaceAll('_', ' ')}`
}

export const ToolHeader = memo(
  ({ className, title, subtitle, state, type }: ToolHeaderProps) => {
    const { isOpen } = useTool()
    const toolName = title ?? type.split('-').slice(1).join('-')
    const isRunning = state === 'input-streaming' || state === 'input-available'
    const Icon = isRunning ? Loader2 : WrenchIcon

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors text-left',
          className
        )}
      >
        <Icon className={cn('size-4 shrink-0', isRunning && 'animate-spin')} />

        <div className="flex-1 min-w-0">
          <div className="break-words">
            {title ?? getStatusText(state, toolName)}
          </div>
          {subtitle && (
            <div className="text-xs text-muted-foreground/70 truncate mt-0.5">
              {subtitle}
            </div>
          )}
        </div>

        <ChevronDownIcon
          className={cn(
            'size-4 shrink-0 transition-transform',
            isOpen ? 'rotate-180' : 'rotate-0'
          )}
        />
      </CollapsibleTrigger>
    )
  }
)

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = memo(
  ({ className, children, ...props }: ToolContentProps) => (
    <CollapsibleContent
      className={cn(
        'mt-4 text-sm relative',
        'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
        className
      )}
      {...props}
    >
      <div className="ml-2 pl-4 border-l-2 border-dotted">{children}</div>
    </CollapsibleContent>
  )
)

export type ToolInputProps = ComponentProps<'div'> & {
  input: unknown
}

/// Roughly how many lines fit in the fixed preview height (`h-80` less its
/// padding, at `text-sm`). Past this the wrapper switches to a definite
/// height so the scroller inside it is bounded.
const SCROLL_AFTER_LINES = 12

/// How many trailing lines stay live-highlighted while a tool input streams.
/// Comfortably more than the box shows, so scrolling back a little during a
/// write still lands on highlighted content, while keeping each pass a fixed
/// cost no matter how large the file grows.
const STREAM_TAIL_LINES = 200

/// Matches the shared `CodeBlock` surface so highlighted tool input looks like
/// every other code block in the app.
///
/// Long lines are wrapped rather than scrolled sideways. Shiki emits
/// `white-space: pre`, so a single long line (a bundled URL, a minified rule)
/// overflows horizontally and pops a horizontal scrollbar mid-stream. That
/// shrinks the viewport height and shifts the scroll maths, which the
/// stick-to-bottom logic reads as the reader scrolling away — following then
/// stops dead on that line. Wrapping keeps the container's width stable.
const HIGHLIGHT_SURFACE =
  '[&>pre]:m-0 [&>pre]:bg-transparent! [&>pre]:p-4 [&>pre]:text-sm [&>pre]:whitespace-pre-wrap [&>pre]:wrap-break-word [&_code]:font-mono [&_code]:text-sm'

/**
 * A multiline string parameter (e.g. the `content` of a file write) rendered
 * as real, syntax-highlighted text instead of one `\n`-escaped JSON line.
 *
 * Highlighting is *self-pacing*: a new pass starts only once the previous one
 * finishes, always against the newest value. Streaming updates arrive far
 * faster than a highlight completes, and the two obvious approaches both fail
 * — rendering every queued result replays a growing backlog of stale frames
 * (the preview visibly lags seconds behind), while dropping any result that is
 * no longer newest starves every frame and the preview freezes. Skipping the
 * intermediate values keeps the view current at whatever rate the machine can
 * actually sustain.
 *
 * The raw text renders until the first highlight lands, so the preview is
 * never blank and stays readable if highlighting fails.
 *
 * Scrolling uses the same `use-stick-to-bottom` behaviour as the conversation
 * itself, so it eases to the tail instead of snapping, handles the height jump
 * when a new line lands, and releases when the reader scrolls away.
 */
const ToolTextBlock = memo(
  ({
    name,
    value,
    language,
    streaming,
  }: {
    name?: string
    value: string
    language: string
    streaming: boolean
  }) => {
    // Highlighting re-tokenises whatever it is given, so feeding it the whole
    // document makes every pass more expensive as the file grows and the
    // preview visibly slows down the longer a write runs. While streaming the
    // view is pinned to the tail, so only the tail can actually be seen:
    // highlight a bounded window of it and the cost stays flat regardless of
    // file size. The complete document is rendered once the write finishes.
    const displayText = useMemo(() => {
      if (!streaming) return value
      let seen = 0
      for (let i = value.length - 1; i >= 0; i--) {
        if (value[i] === '\n' && ++seen > STREAM_TAIL_LINES) {
          return value.slice(i + 1)
        }
      }
      return value
    }, [value, streaming])

    const latestRef = useRef(displayText)
    latestRef.current = displayText
    const runningRef = useRef(false)
    const aliveRef = useRef(true)
    const [html, setHtml] = useState('')
    const [darkHtml, setDarkHtml] = useState('')

    // Once the content is taller than the box, the wrapper needs a definite
    // height (see the note on StickToBottom below). Counted with an early
    // exit so a large file is not re-split on every streamed frame.
    const isScrollable = useMemo(() => {
      let lines = 1
      for (let i = 0; i < displayText.length; i++) {
        if (displayText[i] === '\n' && ++lines > SCROLL_AFTER_LINES) return true
      }
      return false
    }, [displayText])

    useEffect(() => {
      aliveRef.current = true
      return () => {
        aliveRef.current = false
      }
    }, [])

    useEffect(() => {
      if (runningRef.current) return
      runningRef.current = true
      void (async () => {
        let rendered: string | null = null
        while (aliveRef.current && latestRef.current !== rendered) {
          const target: string = latestRef.current
          try {
            const [light, dark] = await highlightCode(target, language as never)
            if (!aliveRef.current) break
            setHtml(light)
            setDarkHtml(dark)
          } catch {
            // Keep the last good render rather than blanking the preview.
          }
          rendered = target
        }
        runningRef.current = false
      })()
    }, [displayText, language])

    return (
      <div className="space-y-1">
        {name && (
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {name}
          </h4>
        )}
        {/* StickToBottom scrolls an inner element it renders with
            `height: 100%`, so this wrapper needs a *definite* height for the
            scroller to be bounded — a `max-height` leaves it indefinite, so
            nothing overflows, nothing scrolls, and the preview just clips
            while content streams in below the fold. Height is only fixed once
            there is more content than fits, so short parameters stay compact.
            Overflow is deliberately not set here: the library assigns
            `overflow: auto` to its own scroller, and setting it on this
            wrapper would scroll the wrong element. */}
        <StickToBottom
          className={cn('relative rounded-md border', isScrollable && 'h-80')}
          initial="smooth"
          resize="smooth"
        >
          <StickToBottom.Content>
            {html ? (
              <>
                <div
                  className={cn('dark:hidden', HIGHLIGHT_SURFACE)}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
                <div
                  className={cn('hidden dark:block', HIGHLIGHT_SURFACE)}
                  dangerouslySetInnerHTML={{ __html: darkHtml }}
                />
              </>
            ) : (
              <pre className="m-0 whitespace-pre-wrap wrap-break-word p-4 font-mono text-sm text-foreground">
                {displayText}
              </pre>
            )}
          </StickToBottom.Content>
        </StickToBottom>
      </div>
    )
  }
)

export const ToolInput = memo(
  ({ className, input, ...props }: ToolInputProps) => {
    const { state } = useTool()
    const streaming = state === 'input-streaming'
    const { compact, blocks } = splitToolInput(input)
    // Sniff from the block itself when no path-like sibling param exists
    // (a `content`-only write is common), so it does not fall back to
    // markdown and render uncoloured.
    const blockLanguage = guessBlockLanguage(compact, blocks[0]?.value)

    return (
      <div className={cn('space-y-2', className)} {...props}>
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Parameters
        </h4>
        {blocks.length === 0 ? (
          <div className="rounded-md max-h-40 overflow-auto border ">
            <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
          </div>
        ) : (
          <>
            {compact && (
              <div className="rounded-md max-h-40 overflow-auto border">
                <CodeBlock
                  code={JSON.stringify(compact, null, 2)}
                  language="json"
                />
              </div>
            )}
            {blocks.map((block) => (
              <ToolTextBlock
                key={block.key}
                name={block.key}
                value={block.value}
                language={blockLanguage}
                streaming={streaming}
              />
            ))}
          </>
        )}
      </div>
    )
  }
)

type ToolImageProps = {
  data: string
  index: number
  resolver: (input: string) => Promise<string>
}

const ToolImage = memo(({ data, index }: ToolImageProps) => {
  // Prepare the URL - convert base64 to data URL if needed
  const [preparedUrl, setPreparedUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (data.startsWith('data:image') || data.startsWith('http')) {
      // Already a data URL or HTTP URL
      setPreparedUrl(data)
    } else {
      // Assume it's base64 encoded
      setPreparedUrl(`data:image/png;base64,${data}`)
    }
  }, [data])

  const isLoading = !preparedUrl

  if (isLoading) {
    return (
      <div className="flex justify-center">
        <div className="flex size-24 items-center justify-center rounded-md bg-muted">
          <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    )
  }

  if (!preparedUrl) {
    return null
  }

  return (
    <div key={index} className="inline-block">
      <img
        src={preparedUrl}
        alt="Tool output"
        className="max-w-full max-h-96 w-auto h-auto object-contain rounded-md border"
      />
    </div>
  )
})

export type ToolOutputProps = ComponentProps<'div'> & {
  output?: unknown
  errorText?: string
  resolver: (input: string) => Promise<string>
}

export const ToolOutput = memo(
  ({ className, output, errorText, resolver, ...props }: ToolOutputProps) => {
    const Output = useMemo(() => {
      if (!(output || errorText)) {
        return null
      }

      // Handle string output
      if (typeof output === 'string') {
        return (
          <ToolTextBlock
            value={output}
            language={guessBlockLanguage(null, output)}
            streaming={false}
          />
        )
      }

      if (typeof output === 'object' && !isValidElement(output)) {
        // Check if output has content array (new structure: {content: [{text, type}, {data, type: image}]})
        if (
          output &&
          typeof output === 'object' &&
          'content' in output &&
          Array.isArray(output.content)
        ) {
          const content = output.content as Array<{
            type: string
            text?: string
            data?: string
            mimeType?: string
          }>

          const textItems = content.filter((item) => item.type === 'text')
          const imageItems = content.filter((item) => item.type === 'image')

          return (
            <div className="space-y-4">
              {textItems.length > 0 && (
                <div className="space-y-2">
                  {textItems.map((item, index) => (
                    <ToolTextBlock
                      key={index}
                      value={item.text || ''}
                      language={guessBlockLanguage(null, item.text)}
                      streaming={false}
                    />
                  ))}
                </div>
              )}
              {imageItems.length > 0 && (
                <div className="space-y-2">
                  {imageItems.map((item, index) => (
                    <ToolImage
                      key={index}
                      data={item.data || ''}
                      index={index}
                      resolver={resolver}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        }

        // Handle old array format for backward compatibility
        if (Array.isArray(output)) {
          const hasImages = output.some(
            (item) => item?.type === 'image' && (item?.data || item?.image)
          )

          if (hasImages) {
            // Filter out images from JSON and render images separately
            const nonImageOutput = output.filter(
              (item) => item?.type !== 'image'
            )

            return (
              <div className="space-y-4">
                {nonImageOutput.length > 0 && (
                  <div className="rounded-md max-h-40 overflow-auto rounded-md border ">
                    <CodeBlock
                      code={JSON.stringify(nonImageOutput, null, 2)}
                      language="json"
                    />
                  </div>
                )}
                {output
                  .filter(
                    (item) =>
                      item?.type === 'image' && (item?.data || item?.image?.url)
                  )
                  .map((item, index) => (
                    <ToolImage
                      key={index}
                      data={item.data ?? item.image?.url}
                      index={index}
                      resolver={resolver}
                    />
                  ))}
              </div>
            )
          }

          return (
            <div className="rounded-md max-h-40 overflow-auto border ">
              <CodeBlock
                code={JSON.stringify(output, null, 2)}
                language="json"
              />
            </div>
          )
        }

        // Handle regular object
        const { compact, blocks } = splitToolInput(output)
        if (blocks.length > 0) {
          return (
            <div className="space-y-2">
              {compact && (
                <div className="rounded-md max-h-40 overflow-auto border">
                  <CodeBlock
                    code={JSON.stringify(compact, null, 2)}
                    language="json"
                  />
                </div>
              )}
              {blocks.map((block) => (
                <ToolTextBlock
                  key={block.key}
                  name={block.key}
                  value={block.value}
                  language={guessBlockLanguage(compact, block.value)}
                  streaming={false}
                />
              ))}
            </div>
          )
        }

        return (
          <div className="rounded-md max-h-40 overflow-auto border ">
            <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
          </div>
        )
      }

      return <div>{output as ReactNode}</div>
    }, [output, errorText, resolver])

    if (!(output || errorText)) {
      return null
    }

    return (
      <div className={cn('space-y-2 mt-4', className)} {...props}>
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {errorText ? 'Error' : 'Result'}
        </h4>
        <div className="rounded-md overflow-hidden">
          {errorText && (
            <div className="m-2 whitespace-pre-wrap p-2 bg-destructive/10 text-destructive rounded-md">
              {errorText}
            </div>
          )}
          {Output}
        </div>
      </div>
    )
  }
)

Tool.displayName = 'Tool'
ToolHeader.displayName = 'ToolHeader'
ToolContent.displayName = 'ToolContent'
ToolInput.displayName = 'ToolInput'
ToolOutput.displayName = 'ToolOutput'
