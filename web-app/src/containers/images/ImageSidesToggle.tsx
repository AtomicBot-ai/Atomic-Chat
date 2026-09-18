import { memo } from 'react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { OutpaintSides } from '@/lib/diffusion/outpaint'
import { cn } from '@/lib/utils'

type ImageSidesToggleProps = {
  value: OutpaintSides
  disabled?: boolean
  onChange: (value: OutpaintSides) => void
}

const SIDES: Array<keyof OutpaintSides> = ['top', 'bottom', 'left', 'right']

/** Which edges Extend grows: four pressed/unpressed pills in a 2×2 grid. */
export const ImageSidesToggle = memo(function ImageSidesToggle({
  value,
  disabled,
  onChange,
}: ImageSidesToggleProps) {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('images:form.sides')}>
      {SIDES.map((side) => (
        <Button
          key={side}
          type="button"
          variant={value[side] ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={value[side]}
          disabled={disabled}
          className={cn('h-8 text-xs', value[side] && 'ring-1 ring-primary/40')}
          onClick={() => onChange({ ...value, [side]: !value[side] })}
        >
          {t(`images:form.side.${side}`)}
        </Button>
      ))}
    </div>
  )
})

export default ImageSidesToggle
