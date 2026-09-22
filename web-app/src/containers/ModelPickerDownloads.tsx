import { ModelLogo } from '@/containers/ModelLogo'
import { useTranslation } from '@/i18n/react-i18next-compat'

/** The picker stays runnable-only; this action leaves for the full Model Hub. */
export function HuggingFaceAction({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  const label = t('common:modelPicker.downloadFromHuggingFace')

  return (
    <div className="shrink-0 border-t p-2">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex h-11 w-full min-w-0 items-center justify-center gap-2.5 rounded-full border border-border/80 bg-secondary/70 px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        data-testid="model-picker-hugging-face-action"
      >
        <ModelLogo
          author="Hugging Face"
          fallback="huggingface"
          className="size-7 rounded-none border-0 bg-transparent dark:bg-transparent"
        />
        <span className="min-w-0 truncate">{label}</span>
      </button>
    </div>
  )
}

/** Concise runnable-model empty/search state; the footer owns the Hub action. */
export function ModelPickerEmptyState({ query }: { query: string }) {
  const searching = query.trim().length > 0
  const { t } = useTranslation()
  return (
    <div className="px-3 py-4" data-testid="model-picker-empty">
      <div className="py-1.5 text-sm text-muted-foreground">
        {searching
          ? t('common:noModelsFoundFor', { searchValue: query })
          : t('common:modelPicker.noRunnableModels')}
      </div>
    </div>
  )
}
