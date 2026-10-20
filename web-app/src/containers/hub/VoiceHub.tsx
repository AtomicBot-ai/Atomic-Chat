import type { ReactNode } from 'react'
import {
  IconChevronDown,
  IconChevronRight,
  IconCircleCheckFilled,
  IconExternalLink,
} from '@tabler/icons-react'
import { ModelLogo } from '@/containers/ModelLogo'
import VoiceModelCard from '@/containers/VoiceModelCard'
import { HubNoResults } from '@/containers/hub/HubSearch'
import { HubSearchToolbar } from '@/containers/hub/HubSearchToolbar'
import {
  VOICE_MODEL_BYTES,
  VOICE_MODEL_HF_REPO,
  VOICE_MODEL_ID,
  VOICE_MODEL_NAME,
} from '@/constants/voice'
import { useVoiceModel } from '@/hooks/useVoiceModel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export type VoiceHubProps = {
  /** The model type picker, first in the toolbar. */
  categoryTabs?: ReactNode
  query: string
  onQueryChange: (query: string) => void
  /** Id of the open model, named by the URL. */
  selectedModelId: string | null
  /** Open the model, or close it (`null`). */
  onSelectModel: (modelId: string | null) => void
}

/** What a search matches the voice model by. */
const SEARCH_TEXT = `${VOICE_MODEL_NAME} ${VOICE_MODEL_HF_REPO} voxtral speech voice`

/**
 * The Hub's Voice category: the speech recognition model that dictation runs
 * on, with the same download, progress and removal as the voice settings.
 */
export function VoiceHub({
  categoryTabs,
  query,
  onQueryChange,
  selectedModelId,
  onSelectModel,
}: VoiceHubProps) {
  const { t } = useTranslation()
  const { installed } = useVoiceModel()
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = terms.every((term) =>
    SEARCH_TEXT.toLowerCase().includes(term)
  )
  const open = selectedModelId === VOICE_MODEL_ID

  return (
    <div
      className="grid h-svh w-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]"
      data-testid="voice-hub"
    >
      <HubSearchToolbar
        modelType={categoryTabs}
        value={query}
        onChange={onQueryChange}
        placeholder={t('hub:searchVoicePlaceholder')}
      />

      <div className="col-start-1 row-start-2 min-h-0 min-w-0 overflow-y-auto p-2">
        {matches ? (
          <>
            <p className="px-2 pb-3 pt-2 text-xs text-muted-foreground">
              {t('hub:voiceModels')}
            </p>
            <div className="rounded-lg border border-border">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => onSelectModel(open ? null : VOICE_MODEL_ID)}
                className={cn(
                  'flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-accent',
                  open && 'rounded-b-none'
                )}
              >
                {open ? (
                  <IconChevronDown size={14} className="shrink-0" />
                ) : (
                  <IconChevronRight size={14} className="shrink-0" />
                )}
                <ModelLogo
                  name={VOICE_MODEL_NAME}
                  icon="mistral"
                  className="size-9 rounded-lg"
                />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {VOICE_MODEL_NAME}
                  </span>
                  {installed && (
                    <IconCircleCheckFilled
                      size={16}
                      className="shrink-0 text-emerald-600 dark:text-emerald-400"
                      aria-label={t('hub:downloaded')}
                    />
                  )}
                </span>
                <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
                  {t('hub:voiceTagline')}
                </span>
              </button>
              {open && (
                <div className="flex flex-col gap-4 border-t border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="min-w-0 text-sm text-muted-foreground">
                      {t('common:voiceInput.setup.model.tagline')}
                      <span className="mx-1.5 text-muted-foreground/50">·</span>
                      <span className="whitespace-nowrap tabular-nums">
                        {t('common:voiceInput.setup.model.sizeGb', {
                          size: (VOICE_MODEL_BYTES / 1024 ** 3).toFixed(2),
                        })}
                      </span>
                    </p>
                    <VoiceModelCard variant="settings" />
                  </div>
                  <a
                    href={`https://huggingface.co/${VOICE_MODEL_HF_REPO}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 w-fit items-center gap-1.5 rounded-full border border-border px-3 text-xs hover:bg-secondary"
                  >
                    <img
                      src="/images/model-provider/huggingface.svg"
                      alt=""
                      className="size-4"
                    />
                    {t('hub:source.huggingFace')}
                    <IconExternalLink size={12} />
                  </a>
                </div>
              )}
            </div>
          </>
        ) : (
          <HubNoResults
            message={t('hub:noVoiceModels')}
            onClearSearch={
              query.length > 0 ? () => onQueryChange('') : undefined
            }
          />
        )}
      </div>
    </div>
  )
}
