import { useTranslation } from '@/i18n/react-i18next-compat'
import { useRemoteMediaForm } from '@/hooks/useRemoteMediaForm'
import {
  effectiveImageOptions,
  remoteChoiceLabel,
} from '@/lib/media-capabilities'
import type {
  ImageModelDescriptor,
  MediaChoice,
  RemoteImageOptions,
} from '@/services/media/types'
import { AdvancedSelect } from './AdvancedSelect'

type ChoiceKey = Exclude<keyof RemoteImageOptions, 'size'>

const CHOICES: Array<
  [ChoiceKey, keyof ImageModelDescriptor['params'], string]
> = [
  ['aspectRatio', 'aspect_ratios', 'images:remote.aspectRatio'],
  ['resolution', 'resolutions', 'images:remote.resolution'],
  ['quality', 'quality', 'images:remote.quality'],
  ['background', 'background', 'images:remote.background'],
  ['outputFormat', 'output_format', 'images:remote.outputFormat'],
]

/**
 * The settings only a provider's image model takes: a size from its list, an aspect ratio and
 * resolution tier, quality, background and file format. Each shows only when the model offers it,
 * and shows the value the request will carry (the model's default for one it does not take).
 */
export function RemoteImageOptionsFields({
  descriptor,
  disabled,
}: {
  descriptor: ImageModelDescriptor
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const form = useRemoteMediaForm((state) => state.image)
  const patch = useRemoteMediaForm((state) => state.patchImage)
  const effective = effectiveImageOptions(descriptor, form)
  const { params } = descriptor
  const options = (choice: MediaChoice): Array<[string, string]> =>
    choice.values.map((value) => [value, remoteChoiceLabel(value, t)])

  return (
    <div className="flex flex-col gap-3" data-testid="remote-image-options">
      {params.size?.kind === 'enum' && effective.size !== undefined && (
        <AdvancedSelect
          label={t('images:remote.size')}
          value={effective.size}
          options={options(params.size)}
          disabled={disabled}
          onChange={(size) => patch({ size })}
        />
      )}
      {CHOICES.map(([key, param, label]) => {
        const choice = params[param] as MediaChoice | undefined
        const value = effective[key]
        if (!choice || value === undefined) return null
        return (
          <AdvancedSelect
            key={key}
            label={t(label)}
            value={value}
            options={options(choice)}
            disabled={disabled}
            onChange={(next) => patch({ [key]: next })}
          />
        )
      })}
    </div>
  )
}
