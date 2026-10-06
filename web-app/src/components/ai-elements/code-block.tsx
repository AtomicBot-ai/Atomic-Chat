/* eslint-disable react-refresh/only-export-components */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CheckIcon, CopyIcon } from 'lucide-react'
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { type BundledLanguage, codeToHtml, type ShikiTransformer } from 'shiki'

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string
  language: BundledLanguage
  showLineNumbers?: boolean
}

type CodeBlockContextType = {
  code: string
}

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: '',
})

// The number is drawn by a `::before` pseudo-element from `data-line-number`
// rather than a text node: a selection copies text nodes, so every copied line
// came out prefixed with its number (#280). Generated content is never part of
// a selection. No `select-none` on the gutter: a drag that starts on a number
// must still select the code.
const lineNumberTransformer: ShikiTransformer = {
  name: 'line-numbers',
  line(node, line) {
    // The number text used to keep a blank line non-empty. Without it the line
    // holds no text, and under the artifact's `whitespace-normal` the newline
    // between lines collapses, so a copy dropped the blank line. A `<br>` keeps
    // the line break in the selection.
    const isBlank = node.children.length === 0
    node.children.unshift({
      type: 'element',
      tagName: 'span',
      properties: {
        className: [
          'inline-block',
          'min-w-10',
          'mr-4',
          'text-right',
          'text-muted-foreground',
          'before:content-[attr(data-line-number)]',
        ],
        dataLineNumber: String(line),
        ariaHidden: 'true',
      },
      children: [],
    })
    if (isBlank) {
      node.children.push({
        type: 'element',
        tagName: 'br',
        properties: {},
        children: [],
      })
    }
  },
}

export async function highlightCode(
  code: string,
  language: BundledLanguage,
  showLineNumbers = false
) {
  const transformers: ShikiTransformer[] = showLineNumbers
    ? [lineNumberTransformer]
    : []

  return await Promise.all([
    codeToHtml(code, {
      lang: language,
      theme: 'one-light',
      transformers,
    }),
    codeToHtml(code, {
      lang: language,
      theme: 'one-dark-pro',
      transformers,
    }),
  ])
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const [html, setHtml] = useState<string>('')
  const [darkHtml, setDarkHtml] = useState<string>('')
  const mounted = useRef(false)

  useEffect(() => {
    highlightCode(code, language, showLineNumbers).then(([light, dark]) => {
      if (!mounted.current) {
        setHtml(light)
        setDarkHtml(dark)
        mounted.current = true
      }
    })

    return () => {
      mounted.current = false
    }
  }, [code, language, showLineNumbers])

  return (
    <CodeBlockContext.Provider value={{ code }}>
      <div
        className={cn(
          'group relative min-w-0 w-full overflow-hidden bg-background text-foreground',
          className
        )}
        {...props}
      >
        <div className="relative">
          <div
            className="overflow-x-hidden dark:hidden [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&>pre]:whitespace-pre-wrap [&>pre]:wrap-anywhere [&_code]:block [&_code]:font-mono [&_code]:text-sm [&_code]:wrap-anywhere [&_span]:whitespace-pre-wrap [&_span]:wrap-anywhere"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <div
            className="hidden overflow-x-hidden dark:block [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&>pre]:whitespace-pre-wrap [&>pre]:wrap-anywhere [&_code]:block [&_code]:font-mono [&_code]:text-sm [&_code]:wrap-anywhere [&_span]:whitespace-pre-wrap [&_span]:wrap-anywhere"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
            dangerouslySetInnerHTML={{ __html: darkHtml }}
          />
          {children && (
            <div className="absolute top-2 right-2 flex items-center gap-2">
              {children}
            </div>
          )}
        </div>
        {/* <CodeBlockCopyButton className="absolute top-0 right-0"/> */}
      </div>
    </CodeBlockContext.Provider>
  )
}

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void
  onError?: (error: Error) => void
  timeout?: number
}

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false)
  const { code } = useContext(CodeBlockContext)

  const copyToClipboard = async () => {
    if (typeof window === 'undefined' || !navigator?.clipboard?.writeText) {
      onError?.(new Error('Clipboard API not available'))
      return
    }

    try {
      await navigator.clipboard.writeText(code)
      setIsCopied(true)
      onCopy?.()
      setTimeout(() => setIsCopied(false), timeout)
    } catch (error) {
      onError?.(error as Error)
    }
  }

  const Icon = isCopied ? CheckIcon : CopyIcon

  return (
    <Button
      className={cn('shrink-0', className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  )
}
