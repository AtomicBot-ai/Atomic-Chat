import { type ChangeEvent } from 'react'
import { IconSearch } from '@tabler/icons-react'
import { Loader } from 'lucide-react'

import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export type HubSearchFieldProps = {
  /** Spinner while an exact-repo or Hugging Face lookup is in flight. */
  loading: boolean
  value: string
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  /** Escape clears the active query. */
  onClear: () => void
}

export function HubSearchField({
  loading,
  value,
  onChange,
  onClear,
}: HubSearchFieldProps) {
  const { t } = useTranslation()
  const leftPanelOpen = useLeftPanel((state) => state.open)

  return (
    /* The negative margins pull the field to the column's 8px insets so its
       edges line up with the model rows below (the list's `p-2`). The left
       pull applies only while the panel is open: collapsed, HeaderPage
       renders the sidebar toggle beside the field and the margin would eat
       the row's `gap-2`. No right reserve: window controls overlay the
       detail column, not this header. */
    <div
      className={cn(
        'relative z-20 -mr-2 flex h-10 items-center',
        leftPanelOpen && '-ml-2'
      )}
      {...(IS_WINDOWS || IS_MACOS ? { 'data-tauri-drag-region': true } : {})}
    >
      {/* The box is what makes it a field: a bare input on the header
          read as a label. */}
      <div
        data-testid="hub-search-field"
        className="flex h-8 w-full items-center gap-2 rounded-md border border-border/60 px-2.5 transition-colors focus-within:border-border"
      >
        {loading ? (
          <Loader className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <IconSearch className="shrink-0 text-muted-foreground" size={14} />
        )}
        <input
          placeholder={t('hub:searchPlaceholder')}
          value={value}
          onChange={onChange}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value) {
              e.preventDefault()
              onClear()
            }
          }}
          autoComplete="off"
          aria-label={t('hub:searchPlaceholder')}
          className="hub-models-search-input w-full min-w-0 flex-1 bg-transparent bg-clip-padding text-foreground shadow-none transition-none animate-none placeholder:text-muted-foreground focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
      </div>
    </div>
  )
}
