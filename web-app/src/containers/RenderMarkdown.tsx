import { Components } from 'react-markdown'
import {
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  type ComponentType,
  type MemoExoticComponent,
  type ReactNode,
} from 'react'
import { cn, disableIndentedCodeBlockPlugin } from '@/lib/utils'
import { ttftEnabled, ttftMark, ttftReport } from '@/lib/ttft-timing'
import { resolveCodeBlockFileName } from '@/lib/codeBlockFilename'
// import 'katex/dist/katex.min.css'
import {
  defaultRehypePlugins,
  Streamdown,
  type MermaidErrorComponentProps,
} from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'

import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { MermaidError } from '@/components/MermaidError'
import { ArtifactStreamingProvider, ArtifactTrigger } from './ArtifactPanel'

interface MarkdownProps {
  content: string
  className?: string
  components?: Components
  isUser?: boolean
  isStreaming?: boolean
  messageId?: string
  isAnimating?: boolean
  enableHtmlPreview?: boolean
  allowRawHtml?: boolean
}

const HTML_LANGUAGES = new Set(['html', 'htm'])

// Stable plugin configuration shared by the top-level renderer and the nested
// renderer used to delegate non-HTML code blocks back to streamdown.
const REMARK_PLUGINS = [remarkGfm, remarkMath, disableIndentedCodeBlockPlugin]
const REHYPE_PLUGINS = [rehypeKatex, defaultRehypePlugins.harden]
const REHYPE_PLUGINS_WITH_RAW_HTML = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
  rehypeKatex,
]
const STREAMDOWN_PLUGINS = { code, mermaid, cjk }
const STREAMDOWN_CONTROLS = { mermaid: { fullscreen: false } }

/** Pick a fence longer than any backtick run inside the code. */
function makeFence(source: string): string {
  const runs = source.match(/`+/g)
  let longest = 0
  if (runs) {
    for (const run of runs) longest = Math.max(longest, run.length)
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

// Some models emit a full HTML document as raw text (no ```html fence),
// especially when asked to "output only the document". Wrap it in a fence so
// the artifact pipeline still renders a preview. Conservative: only when the
// document is at the very start, and never when already fenced.
function wrapBareHtmlDocument(content: string): string {
  const leading = content.match(/^\s*/)?.[0] ?? ''
  const rest = content.slice(leading.length)
  if (rest.startsWith('```')) return content
  const lower = rest.toLowerCase()
  if (!lower.startsWith('<!doctype html') && !lower.startsWith('<html')) {
    return content
  }
  const fence = makeFence(rest)
  return `${leading}${fence}html\n${rest}\n${fence}`
}

/** Best-effort extraction of the raw text from a `code` element's children. */
function extractCodeText(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) {
    return children
      .map((child) =>
        typeof child === 'string'
          ? child
          : isValidElement(child) &&
              typeof (child.props as { children?: unknown })?.children ===
                'string'
            ? (child.props as { children: string }).children
            : ''
      )
      .join('')
  }
  if (
    isValidElement(children) &&
    typeof (children.props as { children?: unknown })?.children === 'string'
  ) {
    return (children.props as { children: string }).children
  }
  return ''
}

const REACT_MEMO_TYPE = Symbol.for('react.memo')

function isMemoComponent(
  type: unknown
): type is MemoExoticComponent<ComponentType<Record<string, unknown>>> {
  return (
    typeof type === 'object' &&
    type !== null &&
    (type as { $$typeof?: symbol }).$$typeof === REACT_MEMO_TYPE
  )
}

/**
 * `pre` for the nested renderer that delegates code blocks back to streamdown.
 *
 * streamdown 2.1.1 memoises its `code` renderer on the hast node's start/end
 * line and column. The nested renderer always receives a closed fence, so a
 * final line that is still growing keeps the exact same position and the
 * block never re-renders: it froze at the first token of its last line, and
 * the copy button inside that subtree copied the stale text (#263). A new
 * line moves `end.line`, which is why every line but the last was intact.
 *
 * streamdown's own `pre` just returns its child — the memoised `code`
 * element — so render that element's inner component directly and the
 * position comparator is never consulted. The `Block` memo one level up still
 * skips unchanged content. Falls back to the child untouched if it isn't a
 * memo element. Delete once the app moves to upstream streamdown ≥ 2.6, whose
 * comparator already accounts for this.
 */
const UnmemoizedCodePre: Components['pre'] = ({ children }) => {
  const child = Array.isArray(children)
    ? children.find(isValidElement)
    : children
  if (!isValidElement(child) || !isMemoComponent(child.type)) return children
  const Inner = child.type.type
  return <Inner {...(child.props as Record<string, unknown>)} />
}

// Cache for normalized LaTeX content
const latexCache = new Map<string, string>()

/**
 * Optimized preprocessor: normalize LaTeX fragments into $ / $$.
 * Uses caching to avoid reprocessing the same content.
 */
const normalizeLatex = (input: string): string => {
  // Check cache first
  if (latexCache.has(input)) {
    return latexCache.get(input)!
  }

  const segments = input.split(/(```[\s\S]*?```|`[^`]*`|<[a-zA-Z/_!][^>]*>)/g)

  let result = ''

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (!segment) continue

    // Captured code blocks, inline code, html tags
    if (i % 2 === 1) {
      result += segment
      continue
    }

    let s = segment

    // --- Escape suspicious $<number> to prevent Markdown from treating it as LaTeX
    // Example: "$1" → "\$1"
    s = s.replace(/\$(\d+)(?![^\n]*\$([^\d]|$))/g, (_, num) => '\\$' + num)

    // --- Display math: \[...\] surrounded by newlines
    if (s.includes('\\['))
      s = s.replace(
        /(^|\n)\\\[\s*\n([\s\S]*?)\n\s*\\\](?=\n|$)/g,
        (_, pre, inner) => `${pre}$$\n${inner.trim()}\n$$`
      )

    // --- Inline math: space \( ... \)
    if (s.includes('\\('))
      s = s.replace(
        /(^|[^$\\])\\\((.+?)\\\)(?=[^$\\]|$)/g,
        (_, pre, inner) => `${pre}$${inner.trim()}$`
      )

    result += s
  }

  // Cache the result (with size limit to prevent memory leaks)
  if (latexCache.size > 100) {
    const firstKey = latexCache.keys().next().value || ''
    latexCache.delete(firstKey)
  }
  latexCache.set(input, result)

  return result
}

function RenderMarkdownComponent({
  content,
  className,
  isUser,
  components,
  messageId,
  isAnimating,
  isStreaming,
  enableHtmlPreview,
  allowRawHtml,
}: MarkdownProps) {
  const rehypePlugins = allowRawHtml
    ? REHYPE_PLUGINS_WITH_RAW_HTML
    : REHYPE_PLUGINS

  const normalizedContent = useMemo(() => {
    const prepared = enableHtmlPreview ? wrapBareHtmlDocument(content) : content
    return normalizeLatex(prepared)
  }, [content, enableHtmlPreview])
  const thetaMarked = useRef(false)

  useEffect(() => {
    thetaMarked.current = false
  }, [messageId])

  useEffect(() => {
    // The mark is unconditional so `ttft_render_ms` (how long the UI lags
    // behind the first token) reaches analytics in shipped builds; only the
    // developer console table stays behind the dev gate.
    if (content.length > 0 && !thetaMarked.current) {
      thetaMarked.current = true
      ttftMark('thetaFirstRender')
      if (ttftEnabled()) ttftReport('first-visible-render')
    }
  }, [content, messageId])

  const mermaidConfig = useMemo(
    () =>
      messageId
        ? {
            errorComponent: (props: MermaidErrorComponentProps) => (
              <MermaidError messageId={messageId} {...props} />
            ),
          }
        : {},
    [messageId]
  )

  // Props for the nested renderer that delegates non-HTML code blocks back to
  // streamdown so mermaid / syntax highlighting behave exactly as before.
  // Memoised so streamdown's `Block` sees one stable `components` identity.
  const delegateComponents = useMemo<Components>(
    () => ({ ...(components ?? {}), pre: UnmemoizedCodePre }),
    [components]
  )
  const delegateProps = useMemo(
    () => ({
      animate: false as const,
      linkSafety: { enabled: false },
      remarkPlugins: REMARK_PLUGINS,
      rehypePlugins: REHYPE_PLUGINS,
      plugins: STREAMDOWN_PLUGINS,
      controls: STREAMDOWN_CONTROLS,
      mermaid: mermaidConfig,
      components: delegateComponents,
    }),
    [delegateComponents, mermaidConfig]
  )

  const mergedComponents = useMemo<Components | undefined>(() => {
    if (!enableHtmlPreview) return components

    const CodeRenderer: Components['code'] = ({
      node,
      className: codeClassName,
      children,
      ...props
    }) => {
      const position = node?.position
      const isInline = position
        ? position.start?.line === position.end?.line
        : false

      if (isInline) {
        return (
          <code
            className={cn(
              'rounded bg-muted px-1.5 py-0.5 font-mono text-sm',
              codeClassName
            )}
            data-streamdown="inline-code"
            {...props}
          >
            {children}
          </code>
        )
      }

      const match =
        typeof codeClassName === 'string'
          ? codeClassName.match(/language-([^\s]+)/)
          : null
      const language = (match?.[1] ?? '').toLowerCase()
      const codeText = extractCodeText(children)

      if (HTML_LANGUAGES.has(language)) {
        // `streaming` arrives through context: keeping it out of this closure
        // is what lets `CodeRenderer` keep one identity for the whole message.
        return <ArtifactTrigger code={codeText} />
      }

      // Delegate every other code block (incl. mermaid) to streamdown.
      //
      // The fence is rebuilt from the language alone, which drops the info
      // string — and with it the filename the model gave the file. Recover it
      // from the hast node before delegating and publish it on a wrapper, so
      // the download handler can save `styles.css` instead of `file.css`
      // (issue #255).
      const fileName = resolveCodeBlockFileName({
        meta: (node?.data as { meta?: string } | undefined)?.meta,
        code: codeText,
        language,
      })
      const fence = makeFence(codeText)
      const reconstructed = `${fence}${match?.[1] ?? ''}\n${codeText}\n${fence}`
      return (
        <div data-code-filename={fileName ?? undefined}>
          <Streamdown {...delegateProps}>{reconstructed}</Streamdown>
        </div>
      )
    }

    return { code: CodeRenderer, ...(components ?? {}) }
  }, [enableHtmlPreview, components, delegateProps])

  const containsMath =
    normalizedContent.includes('$$') ||
    /(^|[^\\])\$[^$\n]+\$/.test(normalizedContent)

  if (
    content.length > 0 &&
    content.length < 32 &&
    !components &&
    !containsMath
  ) {
    return (
      <div
        dir="auto"
        className={cn(
          'markdown wrap-break-word select-text whitespace-pre-wrap',
          isUser && 'is-user',
          className
        )}
      >
        {content}
      </div>
    )
  }

  // Render the markdown content
  return (
    <div
      dir="auto"
      className={cn(
        'markdown wrap-break-word select-text',
        isUser && 'is-user',
        className
      )}
    >
      <ArtifactStreamingProvider value={!!isStreaming}>
        <Streamdown
          animate={isAnimating ?? true}
          animationDuration={500}
          linkSafety={{
            enabled: false,
          }}
          className={cn(
            'size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
            className
          )}
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={rehypePlugins}
          components={mergedComponents}
          plugins={STREAMDOWN_PLUGINS}
          controls={STREAMDOWN_CONTROLS}
          mermaid={mermaidConfig}
        >
          {normalizedContent}
        </Streamdown>
      </ArtifactStreamingProvider>
    </div>
  )
}
export const RenderMarkdown = memo(
  RenderMarkdownComponent,
  (prevProps, nextProps) =>
    prevProps.content === nextProps.content &&
    prevProps.components === nextProps.components &&
    prevProps.enableHtmlPreview === nextProps.enableHtmlPreview &&
    prevProps.allowRawHtml === nextProps.allowRawHtml &&
    // With HTML preview on, re-render on streaming→done to drop the loader.
    (!nextProps.enableHtmlPreview ||
      prevProps.isStreaming === nextProps.isStreaming)
)
