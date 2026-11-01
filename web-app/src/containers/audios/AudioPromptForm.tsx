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
import { Input } from '@/components/ui/input'
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
import { useAudioGeneration } from '@/hooks/useAudioGeneration'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  AUDIO_MODES,
  SPEED_RANGE,
  audioControlShown,
  audioDurationRange,
  audioVoiceLabel,
  type AudioMode,
} from '@/lib/audio/models'
import { cn } from '@/lib/utils'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

import { AudioEngineNotice } from './AudioEngineNotice'
import { AudioJobStatus } from './AudioJobStatus'
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

const digitsOnly = (text: string) => text.replace(/[^\d]/g, '')

/**
 * The Audios form column, laid out as the Images and Video ones: heading and
 * mode, the prompt card, then the model's settings and an Advanced fold. Which
 * settings show is the catalog's `controls`, never the model's id; a loaded
 * model then says which voices it has. Each mode keeps its own settings while
 * the app runs. Pitch and sample rate have no engine parameter and are gone;
 * loop is how the player treats the clip and is never sent.
 */
export const AudioPromptForm = memo(function AudioPromptForm({
  modelsOpen,
  onModelsOpenChange,
}: AudioPromptFormProps) {
  const { t } = useTranslation()
  const { mode, form, model, capabilities, disabledReason } =
    useAudioGeneration()
  const generating = useAudioGenerationStore((state) => state.generating)
  const stopRequested = useAudioGenerationStore((state) => state.stopRequested)
  const setMode = useAudioGenerationStore((state) => state.setMode)
  const change = useAudioGenerationStore((state) => state.changeForm)
  const resetForm = useAudioGenerationStore((state) => state.resetForm)
  const generate = useAudioGenerationStore((state) => state.generate)
  const stop = useAudioGenerationStore((state) => state.stop)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const modes: MediaMode<AudioMode>[] = AUDIO_MODES.map((id) => ({
    id,
    icon: MODE_ICONS[id],
    title: t(`audios:mode.${id}.title`),
    hint: t(`audios:mode.${id}.hint`),
  }))
  const speech = mode === 'speech'
  const shows = (control: Parameters<typeof audioControlShown>[1]) =>
    audioControlShown(model ?? undefined, control)
  const start = () => {
    if (!generating && disabledReason === null) void generate()
  }

  // Before the model runs only its default is known; a running model that
  // lists no voice has nothing to choose from.
  const voices = capabilities?.voices ?? []
  const showVoice = shows('voice') && (!capabilities || voices.length > 0)
  const defaultVoice = model?.default_voice
    ? t('audios:form.voiceDefaultNamed', {
        voice: audioVoiceLabel(model.default_voice),
      })
    : t('audios:form.voiceDefault')
  const [durationMin, durationMax] = audioDurationRange(model ?? undefined)

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        start()
      }}
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
          <AudioEngineNotice />
        </div>

        <MediaPromptCard testId="audio-prompt-card">
          <AudioModelPicker
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
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  start()
                }
              }}
              rows={3}
              className="min-h-20 resize-none rounded-xl bg-background px-3.5 py-2.5"
            />
          </ImageField>
          <ImageGenerateButton
            modality="audio"
            generating={generating}
            stopRequested={stopRequested}
            disabledReason={disabledReason}
            imageCount={1}
            onGenerate={start}
            onStop={() => void stop()}
          />
          <AudioJobStatus />
        </MediaPromptCard>

        <MediaSettingsHeading
          label={t('audios:form.settings')}
          resetLabel={t('audios:form.reset')}
          resetHint={t('audios:form.resetHint')}
          onReset={resetForm}
          disabled={generating}
          testIdPrefix="audio"
        />
        <div className="flex flex-col gap-3">
          {showVoice && (
            <AdvancedSelect
              label={t('audios:form.voice')}
              hint={capabilities ? undefined : t('audios:form.voiceHint')}
              value={form.voice}
              disabled={generating}
              options={[
                ['', defaultVoice],
                ...voices.map(
                  (voice) => [voice, audioVoiceLabel(voice)] as [string, string]
                ),
              ]}
              onChange={(voice) => change({ voice })}
            />
          )}
          {shows('speed') && (
            <ImageParamSlider
              id="audio-speed"
              label={t('audios:form.speed')}
              description={t('audios:form.speedHint')}
              value={form.speed}
              min={SPEED_RANGE[0]}
              max={SPEED_RANGE[1]}
              step={0.1}
              disabled={generating}
              onChange={(speed) => change({ speed })}
            />
          )}
          {shows('language') && (
            <ImageField
              htmlFor="audio-language"
              label={t('audios:form.language')}
            >
              <Input
                id="audio-language"
                value={form.language}
                disabled={generating}
                placeholder={t('audios:form.languagePlaceholder')}
                onChange={(event) => change({ language: event.target.value })}
              />
            </ImageField>
          )}
          {shows('instruct') && (
            <ImageField
              htmlFor="audio-instruct"
              label={t('audios:form.instruct')}
              hint={t('audios:form.instructHint')}
            >
              <Input
                id="audio-instruct"
                value={form.instruct}
                disabled={generating}
                placeholder={t('audios:form.instructPlaceholder')}
                onChange={(event) => change({ instruct: event.target.value })}
              />
            </ImageField>
          )}
          {shows('lyrics') && (
            <ImageField htmlFor="audio-lyrics" label={t('audios:form.lyrics')}>
              <Textarea
                id="audio-lyrics"
                value={form.lyrics}
                disabled={generating}
                placeholder={t('audios:form.lyricsPlaceholder')}
                onChange={(event) => change({ lyrics: event.target.value })}
                rows={3}
                className="min-h-16 resize-none rounded-xl bg-background px-3.5 py-2.5"
              />
            </ImageField>
          )}
          {shows('durationSec') && (
            <ImageParamSlider
              id="audio-duration"
              label={t('audios:form.duration')}
              description={t('audios:form.durationHint')}
              value={form.durationSec}
              min={durationMin}
              max={durationMax}
              step={1}
              disabled={generating}
              onChange={(durationSec) => change({ durationSec })}
            />
          )}
          {shows('bpm') && (
            <ImageField
              htmlFor="audio-tempo"
              label={t('audios:form.tempo')}
              hint={t('audios:form.tempoHint')}
            >
              <Input
                id="audio-tempo"
                inputMode="numeric"
                value={form.bpm}
                disabled={generating}
                placeholder={t('audios:form.auto')}
                onChange={(event) =>
                  change({ bpm: digitsOnly(event.target.value) })
                }
                className="tabular-nums"
              />
            </ImageField>
          )}
          {!speech && (
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
          )}
          {shows('seed') && (
            <ImageSeedField
              id="audio-seed"
              value={form.seed}
              disabled={generating}
              onChange={(seed) => change({ seed })}
            />
          )}
        </div>

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
              {shows('steps') && (
                <ImageField
                  htmlFor="audio-steps"
                  label={t('audios:form.steps')}
                  hint={t('audios:form.stepsHint')}
                >
                  <Input
                    id="audio-steps"
                    inputMode="numeric"
                    value={form.steps}
                    disabled={generating}
                    placeholder={t('audios:form.auto')}
                    onChange={(event) =>
                      change({ steps: digitsOnly(event.target.value) })
                    }
                    className="tabular-nums"
                  />
                </ImageField>
              )}
              {shows('negativePrompt') && (
                <ImageField
                  htmlFor="audio-negative"
                  label={t('audios:form.negativePrompt')}
                >
                  <Input
                    id="audio-negative"
                    value={form.negativePrompt}
                    disabled={generating}
                    placeholder={t('audios:form.negativePromptPlaceholder')}
                    onChange={(event) =>
                      change({ negativePrompt: event.target.value })
                    }
                  />
                </ImageField>
              )}
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span className="font-medium">
                  {t('audios:form.outputFormat')}
                </span>
                <span>{t('audios:form.outputFormatValue')}</span>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </form>
  )
})
