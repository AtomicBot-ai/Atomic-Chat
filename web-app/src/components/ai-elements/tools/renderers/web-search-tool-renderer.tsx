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
  const { t } = useTranslation()
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
        <div className="max-h-80 divide-y divide-border/60 overflow-y-auto">
          {results.map((result, index) => (
            <a
              key={`${result.url ?? result.title}-${index}`}
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-secondary/40"
            >
              <WebsiteIcon url={result.url} size={18} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{result.title}</div>
                {result.url && (
                  <div className="truncate text-xs text-muted-foreground">
                    {getHostname(result.url)}
                  </div>
                )}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
