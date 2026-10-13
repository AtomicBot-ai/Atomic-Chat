import { Switch } from '@/components/ui/switch'
import { AdvancedSelect } from '@/containers/images/AdvancedSelect'
import { useRemoteMediaForm } from '@/hooks/useRemoteMediaForm'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { durationChoices, remoteChoiceLabel } from '@/lib/media-capabilities'
import type {
  MediaChoice,
  RemoteVideoOptions,
  VideoModelDescriptor,
} from '@/services/media/types'

/**
 * The settings a provider's video model takes in place of the local engine's presets, frame
 * lattice and sampling: the clip length, resolution tier, aspect ratio or size, and sound. Each
 * shows only when the model offers it, with the value the request will carry.
 */
export function RemoteVideoOptionsFields({
  descriptor,
  options,
  disabled,
}: {
  descriptor: VideoModelDescriptor
  /** The form's settings checked against the model: what Generate sends. */
  options: RemoteVideoOptions
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const patch = useRemoteMediaForm((state) => state.patchVideo)
  const { params } = descriptor
  const lengths = durationChoices(descriptor)
  const choices = (choice: MediaChoice): Array<[string, string]> =>
    choice.values.map((value) => [value, remoteChoiceLabel(value, t)])

  return (
    <div className="flex flex-col gap-3" data-testid="remote-video-options">
      {lengths.length > 0 && options.durationSecs !== undefined && (
        <AdvancedSelect
          label={t('videos:form.duration')}
          value={options.durationSecs}
          options={lengths.map((seconds) => [
            seconds,
            t('videos:remote.seconds', { seconds }),
          ])}
          disabled={disabled}
          onChange={(durationSecs) => patch({ durationSecs })}
        />
      )}
      {params.resolutions && options.resolution !== undefined && (
        <AdvancedSelect
          label={t('images:remote.resolution')}
          value={options.resolution}
          options={choices(params.resolutions)}
          disabled={disabled}
          onChange={(resolution) => patch({ resolution })}
        />
      )}
      {params.aspect_ratios && options.aspectRatio !== undefined && (
        <AdvancedSelect
          label={t('images:remote.aspectRatio')}
          value={options.aspectRatio}
          options={choices(params.aspect_ratios)}
          disabled={disabled}
          onChange={(aspectRatio) => patch({ aspectRatio })}
        />
      )}
      {params.sizes && options.size !== undefined && (
        <AdvancedSelect
          label={t('images:remote.size')}
          value={options.size}
          options={choices(params.sizes)}
          disabled={disabled}
          onChange={(size) => patch({ size })}
        />
      )}
      {params.audio && (
        <div className="flex h-8 items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">
            {t('videos:remote.audio')}
          </span>
          <Switch
            checked={options.generateAudio ?? true}
            disabled={disabled}
            onCheckedChange={(generateAudio) => patch({ generateAudio })}
            aria-label={t('videos:remote.audio')}
          />
        </div>
      )}
    </div>
  )
}
