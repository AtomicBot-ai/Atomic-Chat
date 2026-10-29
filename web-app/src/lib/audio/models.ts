/**
 * What the Audios page offers before there is an audio engine: its three
 * modes, the models each would run, and the settings each mode starts from.
 * The models are candidates, and nothing downloads them yet: the engine
 * work replaces this list with the catalog's (checking each licence) and
 * gives each model the settings it really takes.
 */

export type AudioMode = 'speech' | 'music' | 'effects'

export const AUDIO_MODES: readonly AudioMode[] = ['speech', 'music', 'effects']

export type AudioModel = { id: string; name: string }

export const AUDIO_MODELS: Record<AudioMode, readonly AudioModel[]> = {
  speech: [
    { id: 'kokoro-82m', name: 'Kokoro 82M' },
    { id: 'qwen3-tts-0.6b', name: 'Qwen3-TTS 0.6B' },
  ],
  music: [{ id: 'ace-step-1.5-turbo', name: 'ACE-Step 1.5 Turbo' }],
  effects: [{ id: 'stable-audio-open-small', name: 'Stable Audio Open Small' }],
}

export type AudioSettings = {
  model: string
  prompt: string
  /** Speech: the model's voice; empty is the model's own default. */
  voice: string
  speed: number
  pitch: number
  /** Music and effects. */
  duration: number
  tempo: number
  loop: boolean
  seed: string
  sampleRate: number
}

export const AUDIO_DURATIONS = [5, 10, 20, 30] as const
export const AUDIO_SAMPLE_RATES = [24000, 32000, 44100] as const

const base = {
  voice: '',
  speed: 1,
  pitch: 1,
  tempo: 90,
  loop: false,
  seed: '42',
}

export const AUDIO_DEFAULTS: Record<AudioMode, AudioSettings> = {
  speech: {
    ...base,
    model: AUDIO_MODELS.speech[0].id,
    prompt: 'A small idea can be the start of something wonderful.',
    duration: 10,
    sampleRate: 24000,
  },
  music: {
    ...base,
    model: AUDIO_MODELS.music[0].id,
    prompt: 'Warm ambient chords with a soft, unhurried melody.',
    duration: 10,
    sampleRate: 32000,
  },
  effects: {
    ...base,
    model: AUDIO_MODELS.effects[0].id,
    prompt: 'A soft electronic chime, bright and spacious.',
    duration: 5,
    sampleRate: 32000,
  },
}

/** A mode's settings put back to its defaults, keeping the prompt and model. */
export function resetAudioSettings(
  mode: AudioMode,
  current: AudioSettings
): AudioSettings {
  return {
    ...AUDIO_DEFAULTS[mode],
    prompt: current.prompt,
    model: current.model,
  }
}

export type AudioGenerateDisabledReason = 'noEngine' | 'noModel' | 'emptyPrompt'

/**
 * Why Generate is off, first reason first. With no audio engine in the app
 * every model is still to download, so today it is always `noEngine`.
 */
export function audioGenerateDisabledReason(
  settings: AudioSettings,
  { engineInstalled, modelReady }: { engineInstalled: boolean; modelReady: boolean }
): AudioGenerateDisabledReason | null {
  if (!engineInstalled) return 'noEngine'
  if (!modelReady) return 'noModel'
  if (!settings.prompt.trim()) return 'emptyPrompt'
  return null
}
