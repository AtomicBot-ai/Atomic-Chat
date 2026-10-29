import { memo, useState } from 'react'
import {
  IconChevronDown,
  IconMicrophone,
  IconMusic,
  IconWaveSine,
} from '@tabler/icons-react'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  collapsiblePanelAnimation,
} from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { AdvancedSelect } from '@/containers/images/AdvancedSelect'
import { ImageField } from '@/containers/images/ImageField'
import { ImageGenerateButton } from '@/containers/images/ImageGenerateButton'
import { ImageParamSlider } from '@/containers/images/ImageParamSlider'
import { ImageSeedField } from '@/containers/images/ImageSeedField'
import {
  MediaModeSelect,
  type MediaMode,
} from '@/containers/images/MediaModeSelect'
import { MediaPageHeading } from '@/containers/images/MediaPageHeading'
import { MediaSettingsHeading } from '@/containers/images/MediaSettingsHeading'
import { MediaPromptCard } from '@/containers/images/MediaStudio'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  AUDIO_DEFAULTS,
  AUDIO_DURATIONS,
  AUDIO_MODES,
  AUDIO_SAMPLE_RATES,
  audioGenerateDisabledReason,
  resetAudioSettings,
  type AudioMode,
  type AudioSettings,
} from '@/lib/audio/models'
import { cn } from '@/lib/utils'

import { AudioModelPicker } from './AudioModelPicker'

const MODE_ICONS = {
  speech: IconMicrophone,
  music: IconMusic,
  effects: IconWaveSine,
}

type AudioPromptFormProps = {
  modelsOpen: boolean
  onModelsOpenChange: (open: boolean) => void
}

/**
 * The Audios form column, laid out as the Images and Video ones: heading and
 * mode, the prompt card, then the mode's settings and an Advanced fold. Each
 * mode keeps its own settings while the page is open. Generate stays off with
 * its reason until there is an audio engine to run the models.
 */
export const AudioPromptForm = memo(function AudioPromptForm({
  modelsOpen,
  onModelsOpenChange,
}: AudioPromptFormProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<AudioMode>('speech')
  const [forms, setForms] = useState(AUDIO_DEFAULTS)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const form = forms[mode]
  const change = (patch: Partial<AudioSettings>) =>
    setForms((all) => ({ ...all, [mode]: { ...all[mode], ...patch } }))

  // No audio engine yet: Generate is off and says why.
  const disabledReason = audioGenerateDisabledReason(form, {
    engineInstalled: false,
    modelReady: false,
  })

  const modes: MediaMode<AudioMode>[] = AUDIO_MODES.map((id) => ({
    id,
    icon: MODE_ICONS[id],
    title: t(`audios:mode.${id}.title`),
    hint: t(`audios:mode.${id}.hint`),
  }))
  const speech = mode === 'speech'

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => event.preventDefault()}
      data-testid="audio-prompt-form"
    >
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-6 pt-4 pb-4 [scrollbar-gutter:stable]"
        data-testid="audio-form-scroller"
      >
        <div className="flex flex-col gap-4">
          <MediaPageHeading
            title={t('audios:page.title')}
            subtitle={t('audios:page.subtitle')}
            testIdPrefix="audio"
          />
          <MediaModeSelect
            modes={modes}
            value={mode}
            onChange={setMode}
            label={t('audios:mode.choose')}
            testIdPrefix="audio"
          />
        </div>

        <MediaPromptCard testId="audio-prompt-card">
          <AudioModelPicker
            mode={mode}
            value={form.model}
            onChange={(model) => change({ model })}
            open={modelsOpen}
            onOpenChange={onModelsOpenChange}
          />
          <ImageField
            htmlFor="audio-prompt"
            label={t(speech ? 'audios:form.text' : 'audios:form.prompt')}
          >
            <Textarea
              id="audio-prompt"
              value={form.prompt}
              maxLength={2000}
              placeholder={t(
                speech
                  ? 'audios:form.textPlaceholder'
                  : 'audios:form.promptPlaceholder'
              )}
              onChange={(event) => change({ prompt: event.target.value })}
              rows={3}
              className="min-h-20 resize-none rounded-xl bg-background px-3.5 py-2.5"
            />
          </ImageField>
          <ImageGenerateButton
            modality="audio"
            generating={false}
            stopRequested={false}
            disabledReason={disabledReason}
            imageCount={1}
            onGenerate={() => {}}
            onStop={() => {}}
          />
        </MediaPromptCard>

        <MediaSettingsHeading
          label={t('audios:form.settings')}
          resetLabel={t('audios:form.reset')}
          resetHint={t('audios:form.resetHint')}
          onReset={() =>
            setForms((all) => ({
              ...all,
              [mode]: resetAudioSettings(mode, all[mode]),
            }))
          }
          testIdPrefix="audio"
        />
        {speech ? (
          <div className="flex flex-col gap-3">
            {/* The voices are the model's: until one runs, its default. */}
            <AdvancedSelect
              label={t('audios:form.voice')}
              value={form.voice}
              options={[['', t('audios:form.voiceDefault')]]}
              onChange={(voice) => change({ voice })}
            />
            <ImageParamSlider
              id="audio-speed"
              label={t('audios:form.speed')}
              description={t('audios:form.speedHint')}
              value={form.speed}
              min={0.5}
              max={1.5}
              step={0.1}
              onChange={(speed) => change({ speed })}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <AdvancedSelect
              label={t('audios:form.duration')}
              value={form.duration}
              options={AUDIO_DURATIONS.map((seconds) => [
                seconds,
                t('audios:form.durationSeconds', { seconds }),
              ])}
              onChange={(duration) => change({ duration })}
            />
            {mode === 'music' && (
              <ImageParamSlider
                id="audio-tempo"
                label={t('audios:form.tempo')}
                description={t('audios:form.tempoHint')}
                value={form.tempo}
                min={60}
                max={160}
                step={5}
                onChange={(tempo) => change({ tempo })}
              />
            )}
            <div className="flex min-h-8 items-center justify-between gap-3">
              <label
                htmlFor="audio-loop"
                className="text-xs font-medium text-muted-foreground"
              >
                {t('audios:form.loop')}
              </label>
              <Switch
                id="audio-loop"
                checked={form.loop}
                onCheckedChange={(loop) => change({ loop })}
              />
            </div>
          </div>
        )}
        {!speech && (
          <ImageSeedField
            id="audio-seed"
            value={form.seed}
            onChange={(seed) => change({ seed })}
          />
        )}

        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          className="mt-1 border-t border-border/60 pt-3"
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary/60"
              data-testid="audio-advanced-toggle"
            >
              <span className="min-w-0 flex-1 text-xs font-medium">
                {t('audios:form.advanced')}
              </span>
              <IconChevronDown
                size={16}
                className={cn(
                  'shrink-0 text-muted-foreground transition-transform',
                  advancedOpen && 'rotate-180'
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent
            className={cn(
              collapsiblePanelAnimation,
              'duration-250 ease-out will-change-[height] motion-reduce:animate-none motion-reduce:duration-0'
            )}
            data-testid="audio-advanced-panel"
          >
            <div className="flex flex-col gap-3 pt-3">
              {speech ? (
                <ImageParamSlider
                  id="audio-pitch"
                  label={t('audios:form.pitch')}
                  description={t('audios:form.pitchHint')}
                  value={form.pitch}
                  min={0.5}
                  max={1.5}
                  step={0.1}
                  onChange={(pitch) => change({ pitch })}
                />
              ) : (
                <>
                  <AdvancedSelect
                    label={t('audios:form.sampleRate')}
                    value={form.sampleRate}
                    options={AUDIO_SAMPLE_RATES.map((rate) => [
                      rate,
                      t('audios:form.sampleRateKhz', { rate: rate / 1000 }),
                    ])}
                    onChange={(sampleRate) => change({ sampleRate })}
                  />
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="font-medium">
                      {t('audios:form.outputFormat')}
                    </span>
                    <span>{t('audios:form.outputFormatValue')}</span>
                  </div>
                </>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </form>
  )
})
