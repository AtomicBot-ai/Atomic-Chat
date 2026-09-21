import type { ToolPresentation } from '@/lib/tools/types'
import { WebsiteIcon } from './website-icon'

type WebFetchToolRendererProps = {
  presentation: Extract<ToolPresentation, { kind: 'web_fetch_exa' }>
}

function getHostname(url?: string) {
  if (!url) return ''
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function WebFetchToolRenderer({
  presentation,
}: WebFetchToolRendererProps) {
  const { pages, errorText } = presentation

  return (
    <div className="space-y-2">
      {errorText && (
        <div className="py-1 text-sm text-destructive">
          {errorText}
        </div>
      )}

      {pages.length > 0 && (
        <div className="max-h-64 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60 bg-background/30 [scrollbar-gutter:stable]">
          {pages.map((page, index) => {
            const content = (
              <>
                <WebsiteIcon
                  url={page.url}
                  domain={page.domain}
                  size={22}
                  className="size-[22px] shrink-0 rounded-full bg-secondary object-cover ring-1 ring-border/60"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {page.title || 'Untitled page'}
                  </div>
                  {(page.domain || page.url) && (
                    <div className="truncate text-xs text-muted-foreground">
                      {page.domain || getHostname(page.url)}
                    </div>
                  )}
                </div>
              </>
            )

            return page.url ? (
              <a
                key={`${page.url}-${index}`}
                href={page.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-secondary/40"
              >
                {content}
              </a>
            ) : (
              <div
                key={`${page.title}-${index}`}
                className="flex min-w-0 items-center gap-2.5 px-2.5 py-2"
              >
                {content}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
