import type { ToolPresentation } from '@/lib/tools/types'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { WebsiteIcon } from './website-icon'

type WebSearchToolRendererProps = {
  presentation: Extract<ToolPresentation, { kind: 'web_search_exa' }>
  onRetry?: () => void
}

function getHostname(url?: string) {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function WebSearchToolRenderer({
  presentation,
  onRetry,
}: WebSearchToolRendererProps) {
  const { t } = useTranslation('chat')
  const { results, errorText } = presentation
  const compactError = errorText
    ?.trim()
    .replace(/^Error:\s*/i, '')
    .replace(/^"|"$/g, '')

  return (
    <div className="space-y-2">
      {compactError && (
        <div className="flex min-w-0 items-center gap-2 py-1 text-sm text-destructive">
          <span className="min-w-0 flex-1">{compactError}</span>
          {onRetry && (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto shrink-0 p-0 text-destructive"
              onClick={onRetry}
            >
              {t('common:retry')}
            </Button>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border/60 bg-background/30">
          <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
            <span className="flex items-center">
              {results.slice(0, 3).map((result, index) => (
                <WebsiteIcon
                  key={`${result.url ?? result.title}-summary-${index}`}
                  url={result.url}
                  domain={result.domain}
                  size={16}
                  className="-ml-1 rounded-full bg-background object-cover ring-2 ring-background first:ml-0"
                />
              ))}
            </span>
            <span>
              {t(
                results.length === 1 ? 'toolCall.result' : 'toolCall.results',
                { count: results.length }
              )}
            </span>
          </div>
          <div className="max-h-64 divide-y divide-border/60 overflow-y-auto [scrollbar-gutter:stable]">
            {results.map((result, index) => (
              <a
                key={`${result.url ?? result.title}-${index}`}
                href={result.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-secondary/40"
              >
                <WebsiteIcon
                  url={result.url}
                  domain={result.domain}
                  size={22}
                  className="size-[22px] shrink-0 rounded-full bg-secondary object-cover ring-1 ring-border/60"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{result.title}</div>
                  {(result.domain || result.url) && (
                    <div className="truncate text-xs text-muted-foreground">
                      {result.domain || getHostname(result.url)}
                    </div>
                  )}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
