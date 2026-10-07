import { useMemo, type ComponentType } from 'react'
import {
  IconArrowsSplit,
  IconChartScatter3d,
  IconMessage,
  IconMovie,
  IconPhoto,
  type IconProps,
} from '@tabler/icons-react'
import { MediaModeSelect } from '@/containers/images/MediaModeSelect'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { HubCategory } from '@/lib/hub-media'

const CATEGORY: Record<
  HubCategory,
  { icon: ComponentType<IconProps>; title: string; hint: string }
> = {
  chat: {
    icon: IconMessage,
    title: 'hub:categoryChat',
    hint: 'hub:categoryChatHint',
  },
  image: {
    icon: IconPhoto,
    title: 'hub:categoryImages',
    hint: 'hub:categoryImagesHint',
  },
  video: {
    icon: IconMovie,
    title: 'hub:categoryVideo',
    hint: 'hub:categoryVideoHint',
  },
  decision: {
    icon: IconArrowsSplit,
    title: 'hub:categoryDecision',
    hint: 'hub:categoryDecisionHint',
  },
  embedding: {
    icon: IconChartScatter3d,
    title: 'hub:categoryEmbedding',
    hint: 'hub:categoryEmbeddingHint',
  },
}

export type HubCategorySelectProps = {
  /** The categories this machine can run, in display order. */
  categories: readonly HubCategory[]
  value: HubCategory
  onChange: (next: HubCategory) => void
}

/**
 * The model type picker above the Hub list, in the shape of the Images and
 * Video mode picker: the active type with its icon, and a menu of every type
 * with what its models do. The `chat` category reads "Text": it lists
 * language models, and next to the others it names what a model makes.
 */
export function HubCategorySelect({
  categories,
  value,
  onChange,
}: HubCategorySelectProps) {
  const { t } = useTranslation()
  const modes = useMemo(
    () =>
      categories.map((id) => ({
        id,
        icon: CATEGORY[id].icon,
        title: t(CATEGORY[id].title),
        hint: t(CATEGORY[id].hint),
      })),
    [categories, t]
  )
  return (
    <MediaModeSelect
      modes={modes}
      value={value}
      onChange={onChange}
      label={t('hub:categories')}
      testIdPrefix="hub-category"
    />
  )
}
