import type { ToolUIPart } from 'ai'
import { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Bell,
  ChevronRight,
  ClipboardList,
  FileText,
  Folder,
  GitBranch,
  Globe,
  Loader2,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ToolPresentation } from '@/lib/tools/types'
import { toolActivityLabel } from '@/lib/tools/activity-label'
import { cn } from '@/lib/utils'
import { Tool, ToolContent } from './tool'
import { WebSearchToolRenderer } from './renderers/web-search-tool-renderer'
import { WebFetchToolRenderer } from './renderers/web-fetch-tool-renderer'
import { GenericToolRenderer } from './renderers/generic-tool-renderer'
import { WebsiteIcon } from './renderers/website-icon'

/** How many result favicons the row shows before the count takes over. */
const FAVICON_LIMIT = 3

function toolIcon(
  toolName: string,
  kind: ToolPresentation['kind']
): LucideIcon {
  if (kind !== 'generic') return Globe
  if (/^os\.(web|http)\./.test(toolName)) return Globe
  if (/^os\.(shell|proc)\./.test(toolName)) return SquareTerminal
  if (toolName.startsWith('os.git.')) return GitBranch
  if (/^os\.fs\.(list|glob|mkdir)$/.test(toolName)) return Folder
  if (toolName.startsWith('os.fs.')) return FileText
  if (toolName.startsWith('os.clipboard.')) return ClipboardList
  if (toolName === 'os.notify') return Bell
  return Wrench
}

/** One readable action; raw parameters and errors remain in the disclosure. */
export function ToolRenderer({
  toolName,
  presentation,
  state,
  onRetry,
}: {
  toolName: string
  presentation: ToolPresentation
  state: ToolUIPart['state']
  onRetry?: () => void
}) {
  const { t } = useTranslation('chat')
  const resultCountId = useId()
  const running = state === 'input-streaming' || state === 'input-available'
  const denied = (state as string) === 'output-denied'
  const failed = state === 'output-error' || denied
  const Icon = running ? Loader2 : toolIcon(toolName, presentation.kind)
  const label = toolActivityLabel(toolName, presentation, state, t)
  const results =
    presentation.kind === 'web_search_exa' && !running && !failed
      ? presentation.results
      : []

  return (
    <Tool state={state} className="group/tool">
      <CollapsibleTrigger
        title={label}
        aria-label={label}
        aria-describedby={results.length > 0 ? resultCountId : undefined}
        className="flex w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0',
            running && 'animate-spin',
            failed && 'text-destructive'
          )}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-xs">
          {results.length > 0 && (
            <>
              <span className="flex items-center">
                {results.slice(0, FAVICON_LIMIT).map((result, index) => (
                  <WebsiteIcon
                    key={`${result.url ?? result.title}-${index}`}
                    url={result.url}
                    size={14}
                    className="-ml-1 rounded-full bg-background ring-2 ring-background first:ml-0"
                  />
                ))}
              </span>
              <span id={resultCountId}>
                {t(
                  results.length === 1 ? 'toolCall.result' : 'toolCall.results',
                  { count: results.length }
                )}
              </span>
            </>
          )}
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 opacity-0 transition group-hover/tool:opacity-100 group-data-[state=open]/tool:rotate-90 group-data-[state=open]/tool:opacity-100"
          />
        </span>
      </CollapsibleTrigger>

      <ToolContent>
        {presentation.kind === 'web_search_exa' && (
          <WebSearchToolRenderer
            presentation={presentation}
            onRetry={onRetry}
          />
        )}

        {presentation.kind === 'web_fetch_exa' && (
          <WebFetchToolRenderer presentation={presentation} />
        )}

        {presentation.kind === 'generic' && (
          <GenericToolRenderer presentation={presentation} />
        )}
      </ToolContent>
    </Tool>
  )
}
