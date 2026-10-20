import { IconCircleCheckFilled } from '@tabler/icons-react'
import { ModelLogo } from '@/containers/ModelLogo'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { DIFFUSION_FAMILY_ICON_KEYS } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type { DiffusionCatalogFamily } from '@/services/diffusion-catalog-registry'

export type MediaFamilyRowProps = {
  family: DiffusionCatalogFamily
  installed?: boolean
  /** The family's details are open below the row. */
  selected?: boolean
  onSelect: () => void
}

/**
 * An image or video family in the Hub's list: logo, name and developer, with a
 * check when it is installed. It opens and closes the family's details below it.
 */
export function MediaFamilyRow({
  family,
  installed = false,
  selected = false,
  onSelect,
}: MediaFamilyRowProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-expanded={selected}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-accent',
        selected && 'rounded-b-none'
      )}
    >
      <ModelLogo
        icon={DIFFUSION_FAMILY_ICON_KEYS[family.id]}
        name={family.name}
        author={family.developer}
        className="size-9 rounded-lg"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {family.name}
          </span>
          {installed && (
            <IconCircleCheckFilled
              size={16}
              className="shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-label={t('images:model.downloaded')}
            />
          )}
        </span>
        {family.developer && (
          <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {family.developer}
          </span>
        )}
      </span>
    </button>
  )
}
