/**
 * Toast for a failed model load.
 *
 * The engines hand us the whole `llama-server` output on a crash, and pasting
 * that into the toast description buried the one sentence that mattered under a
 * hundred lines of log (a screenful of GGML backtrace on first launch). This
 * renders the sentence and keeps the log one click away — still copyable, since
 * it is exactly what a bug report needs.
 */
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import type { CSSProperties } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/containers/CopyButton'
import i18n from '@/i18n/setup'

/** Shared with every other model-load toast so they replace one another. */
const TOAST_ID = 'model-load-error'
const DEFAULT_DURATION_MS = 10_000
/** Expanded, the toast needs more room than the default 356px column. */
const EXPANDED_WIDTH = '440px'

export interface ModelLoadErrorToastOptions {
  title: string
  description: string
  /** Raw engine output, hidden behind the toggle. */
  details?: string
  duration?: number
}

export function showModelLoadErrorToast(
  options: ModelLoadErrorToastOptions
): void {
  renderToast(options, false)
}

function renderToast(
  options: ModelLoadErrorToastOptions,
  expanded: boolean
): void {
  toast.error(options.title, {
    id: TOAST_ID,
    // A log being read must not vanish mid-scroll, so expanding pins the toast.
    duration: expanded ? Infinity : (options.duration ?? DEFAULT_DURATION_MS),
    closeButton: true,
    style: expanded
      ? ({ '--width': EXPANDED_WIDTH } as CSSProperties)
      : undefined,
    description: (
      <ModelLoadErrorBody
        description={options.description}
        details={options.details}
        expanded={expanded}
        onToggle={() => renderToast(options, !expanded)}
      />
    ),
  })
}

function ModelLoadErrorBody({
  description,
  details,
  expanded,
  onToggle,
}: {
  description: string
  details?: string
  expanded: boolean
  onToggle: () => void
}) {
  const log = details?.trim()

  return (
    <div className="flex w-full flex-col gap-2">
      <span>{description}</span>
      {log && (
        <>
          <Button
            variant="ghost"
            size="xs"
            onClick={onToggle}
            className="-ml-1.5 w-fit gap-1 px-1.5 text-muted-foreground"
          >
            {expanded ? (
              <IconChevronDown size={14} />
            ) : (
              <IconChevronRight size={14} />
            )}
            {i18n.t(
              expanded
                ? 'model-errors:hideDetails'
                : 'model-errors:showDetails'
            )}
          </Button>
          {expanded && (
            <div className="relative">
              <pre className="max-h-56 select-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 pr-8 font-mono text-[11px] leading-snug">
                {log}
              </pre>
              <div className="absolute right-1 top-1">
                <CopyButton text={log} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
