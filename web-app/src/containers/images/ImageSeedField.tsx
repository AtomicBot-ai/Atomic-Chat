import { memo } from 'react'
import { IconDice5, IconLock, IconLockOpen } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { randomSeed } from '@/hooks/useImageForm'
import { useTranslation } from '@/i18n/react-i18next-compat'

type ImageSeedFieldProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

/**
 * Seed as text, a dice to roll a new one, and a lock.
 *
 * Empty means "the engine picks" — the seed is then whatever the recipe
 * records, and the dice writes one into the box so it can be kept. The lock
 * is the same thing from the other side: locked = a seed is set, unlocked =
 * cleared. Two controls for one idea, because both gestures are what people
 * reach for.
 */
export const ImageSeedField = memo(function ImageSeedField({
  value,
  onChange,
  disabled,
}: ImageSeedFieldProps) {
  const { t } = useTranslation()
  const locked = value.trim().length > 0

  return (
    <div className="space-y-1.5">
      <label htmlFor="image-seed" className="text-xs font-medium">
        {t('images:form.seed')}
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id="image-seed"
          inputMode="numeric"
          placeholder={t('images:form.seedPlaceholder')}
          value={value}
          disabled={disabled}
          onChange={(event) =>
            onChange(event.target.value.replace(/[^\d]/g, ''))
          }
          className="h-8 font-mono text-xs tabular-nums"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={disabled}
              aria-label={t('images:form.seedRandom')}
              onClick={() => onChange(String(randomSeed()))}
            >
              <IconDice5 size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('images:form.seedRandom')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={disabled}
              aria-pressed={locked}
              aria-label={
                locked ? t('images:form.seedUnlock') : t('images:form.seedLock')
              }
              onClick={() =>
                onChange(locked ? '' : String(randomSeed()))
              }
            >
              {locked ? <IconLock size={16} /> : <IconLockOpen size={16} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {locked ? t('images:form.seedUnlock') : t('images:form.seedLock')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})

export default ImageSeedField
