import { describe, expect, it, vi } from 'vitest'

const transfer = vi.hoisted(() => ({
  transferFiles: vi.fn(async () => {}),
  emitted: [] as Array<[string, ...unknown[]]>,
}))
vi.mock('@/services/diffusion/transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/diffusion/transfer')>()),
  transferFiles: transfer.transferFiles,
  downloadProxyConfig: () => undefined,
  emitTransferProgress: (...args: unknown[]) =>
    transfer.emitted.push(['progress', ...args]),
  emitTransferSuccess: (...args: unknown[]) =>
    transfer.emitted.push(['success', ...args]),
  emitTransferError: (...args: unknown[]) =>
    transfer.emitted.push(['error', ...args]),
  emitTransferValidationFailed: (...args: unknown[]) =>
    transfer.emitted.push(['validation', ...args]),
}))

import { findAudioModel } from '@/services/audio-catalog-registry'

import {
  AUDIO_DEFAULTS,
  adoptAudioModel,
  audioAttributionOf,
  audioDownloadTaskId,
  audioGenerateDisabledReason,
  audioVoiceLabel,
  buildAudioLoadRequest,
  buildAudioRequest,
  downloadAudioModel,
  formsForCatalog,
  isAudioDownloadTaskId,
  isAudioQuantOnDisk,
  resetAudioSettings,
  resolveAudioDownloadTaskId,
  type AudioSettings,
} from '../models'
import {
  ACE,
  MOSS,
  QWEN,
  QWEN_WIRE,
  SFX,
  SFX_WIRE,
  catalog,
} from './audio-fixtures'

const model = (id: string) => {
  const entry = findAudioModel(catalog(), id)
  if (!entry) throw new Error(`No model ${id}`)
  return entry
}
const speech = (patch: Partial<AudioSettings> = {}): AudioSettings => ({
  ...adoptAudioModel(AUDIO_DEFAULTS.speech, model(QWEN)),
  ...patch,
})

describe('the forms a catalog gives', () => {
  it('gives each mode the first model the catalog lists for it', () => {
    const forms = formsForCatalog(AUDIO_DEFAULTS, catalog())

    expect(forms.speech.modelId).toBe(QWEN)
    expect(forms.music.modelId).toBe(ACE)
    expect(forms.effects.modelId).toBe(SFX)
    expect(forms.effects.durationSec).toBe(5)
  })

  it('keeps a model the catalog still lists and what the user wrote', () => {
    const forms = formsForCatalog(
      {
        ...AUDIO_DEFAULTS,
        speech: { ...AUDIO_DEFAULTS.speech, modelId: MOSS, prompt: 'Mine' },
      },
      catalog()
    )

    expect(forms.speech).toMatchObject({ modelId: MOSS, prompt: 'Mine' })
  })

  it('moves a mode off a model the catalog dropped', () => {
    const forms = formsForCatalog(
      {
        ...AUDIO_DEFAULTS,
        speech: { ...AUDIO_DEFAULTS.speech, modelId: 'gone', prompt: 'Mine' },
      },
      catalog()
    )

    expect(forms.speech).toMatchObject({ modelId: QWEN, prompt: 'Mine' })
  })

  it('holds a duration default inside the model’s range', () => {
    const narrow = {
      ...model(ACE),
      defaults: { durationSec: 300 },
      ranges: { durationSec: [5, 60] as [number, number] },
    }

    expect(adoptAudioModel(AUDIO_DEFAULTS.music, narrow).durationSec).toBe(60)
  })

  it('resets the numbers to the model’s and keeps the text', () => {
    const reset = resetAudioSettings(
      {
        ...adoptAudioModel(AUDIO_DEFAULTS.music, model(ACE)),
        prompt: 'Mine',
        lyrics: 'La la',
        durationSec: 45,
        bpm: '120',
        seed: '',
        loop: true,
      },
      model(ACE)
    )

    expect(reset).toMatchObject({
      prompt: 'Mine',
      lyrics: 'La la',
      durationSec: 10,
      bpm: '',
      seed: '42',
      loop: false,
    })
  })
})

describe('buildAudioLoadRequest', () => {
  it('names the file relative to the models folder and carries the voice a model needs', () => {
    const qwen = model(QWEN)

    expect(buildAudioLoadRequest(qwen, qwen.quants[0])).toEqual({
      modelId: QWEN_WIRE,
      displayName: 'Qwen3-TTS 1.7B',
      mode: 'speech',
      file: 'qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf',
      family: 'qwen3_tts',
      task: 'tts',
      defaultVoice: 'vivian',
    })
  })

  it('leaves out a voice the model has no use for', () => {
    const moss = model(MOSS)

    expect(buildAudioLoadRequest(moss, moss.quants[0])).not.toHaveProperty(
      'defaultVoice'
    )
  })

  it('passes the catalog’s options through under the contract’s names', () => {
    const qwen = {
      ...model(QWEN),
      load_options: { a: 1 },
      session_options: { 'qwen3_tts.stitch_decode': true },
      default_request_options: { text_chunk_size: 2048 },
    }

    expect(buildAudioLoadRequest(qwen, qwen.quants[0])).toMatchObject({
      loadOptions: { a: 1 },
      sessionOptions: { 'qwen3_tts.stitch_decode': true },
      defaultRequestOptions: { text_chunk_size: 2048 },
    })
  })
})

describe('buildAudioRequest', () => {
  it('sends only what the model lists: MOSS takes the text and a seed', () => {
    const moss = model(MOSS)

    expect(
      buildAudioRequest(moss, {
        ...adoptAudioModel(AUDIO_DEFAULTS.speech, moss),
        prompt: '  Hello  ',
        voice: 'vivian',
        instruct: 'Calm',
        language: 'en',
        speed: 1.4,
        durationSec: 30,
        negativePrompt: 'noise',
      })
    ).toEqual({ text: 'Hello', seed: 42 })
  })

  it('leaves the voice out while it is the model’s default', () => {
    expect(buildAudioRequest(model(QWEN), speech())).not.toHaveProperty('voice')
  })

  it('sends a picked voice and a style', () => {
    expect(
      buildAudioRequest(
        model(QWEN),
        speech({ voice: 'ryan', instruct: ' Very happy. ' })
      )
    ).toMatchObject({ voice: 'ryan', instruct: 'Very happy.' })
  })

  it('always sends a duration for effects, even when the model lists none', () => {
    const silent = { ...model(SFX), controls: ['seed' as const] }

    expect(
      buildAudioRequest(silent, adoptAudioModel(AUDIO_DEFAULTS.effects, silent))
        .durationSec
    ).toBe(5)
  })

  it('maps tempo to bpm for music and lets an empty one be the model’s', () => {
    const ace = model(ACE)
    const form = adoptAudioModel(AUDIO_DEFAULTS.music, ace)

    expect(buildAudioRequest(ace, form)).not.toHaveProperty('bpm')
    expect(
      buildAudioRequest(ace, { ...form, bpm: '120', lyrics: ' Rise up ' })
    ).toMatchObject({ bpm: 120, lyrics: 'Rise up', durationSec: 10 })
  })

  it('never sends a sample rate, pitch or loop: the engine has no such parameter', () => {
    const ace = model(ACE)
    const request = buildAudioRequest(ace, {
      ...adoptAudioModel(AUDIO_DEFAULTS.music, ace),
      loop: true,
    })

    expect(Object.keys(request).sort()).toEqual(['durationSec', 'seed', 'text'])
  })

  it('lets the core draw a seed when the field is empty', () => {
    expect(
      buildAudioRequest(model(QWEN), speech({ seed: '' }))
    ).not.toHaveProperty('seed')
  })
})

describe('model files', () => {
  const quant = model(MOSS).quants[0]

  it('counts a file only when it is the catalog’s, whole', () => {
    const file = {
      path: `/data/audio/models/${quant.filename}`,
      relativePath: quant.filename,
    }

    expect(isAudioQuantOnDisk(quant, [{ ...file, bytes: quant.bytes }])).toBe(
      true
    )
    expect(isAudioQuantOnDisk(quant, [{ ...file, bytes: 10 }])).toBe(false)
    expect(isAudioQuantOnDisk(quant, [])).toBe(false)
  })

  it('resolves a sanitized task id back to its model, and nothing else', () => {
    const id = audioDownloadTaskId(QWEN_WIRE)

    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(isAudioDownloadTaskId(id)).toBe(true)
    expect(resolveAudioDownloadTaskId(catalog(), id)?.model.id).toBe(QWEN)
    expect(resolveAudioDownloadTaskId(catalog(), 'audio-model-gone')).toBeNull()
    expect(resolveAudioDownloadTaskId(catalog(), 'embedding-x')).toBeNull()
  })

  it('downloads from the pinned revision with the size and hash the downloader checks', async () => {
    transfer.emitted.length = 0
    transfer.transferFiles.mockClear()
    const qwen = model(QWEN)
    const taskId = audioDownloadTaskId(QWEN_WIRE)

    await downloadAudioModel(qwen, qwen.quants[0], { hfToken: 'token' })

    expect(transfer.transferFiles).toHaveBeenCalledWith(
      [
        {
          url: `https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/${qwen.revision}/${qwen.quants[0].path}`,
          save_path: `audio/models/${qwen.quants[0].filename}`,
          sha256: qwen.quants[0].sha256,
          size: qwen.quants[0].bytes,
          model_id: taskId,
        },
      ],
      taskId,
      expect.objectContaining({ resume: true, hfToken: 'token' })
    )
    expect(transfer.emitted.map(([kind]) => kind)).toEqual([
      'progress',
      'success',
    ])
  })

  it('reports a file that failed its check as a validation failure', async () => {
    transfer.emitted.length = 0
    transfer.transferFiles.mockRejectedValueOnce(
      new Error('Hash verification failed')
    )
    const moss = model(MOSS)

    await expect(downloadAudioModel(moss, moss.quants[0])).rejects.toThrow(
      'Hash verification failed'
    )

    expect(transfer.emitted.map(([kind]) => kind)).toEqual([
      'progress',
      'validation',
    ])
  })
})

describe('audioGenerateDisabledReason', () => {
  const ready = {
    core: 'ready' as const,
    engineInstalled: true,
    modelReady: true,
    modelLoading: false,
    capabilities: null,
  }
  const form = speech()

  it('says the core is too old before anything else', () => {
    expect(
      audioGenerateDisabledReason(form, {
        ...ready,
        core: 'too-old',
        engineInstalled: false,
        modelReady: false,
      })
    ).toBe('coreTooOld')
  })

  it('walks from the engine to the model to the prompt', () => {
    expect(
      audioGenerateDisabledReason(form, { ...ready, core: 'unreachable' })
    ).toBe('coreUnavailable')
    expect(
      audioGenerateDisabledReason(form, { ...ready, engineInstalled: false })
    ).toBe('noEngine')
    expect(
      audioGenerateDisabledReason(form, { ...ready, modelReady: false })
    ).toBe('noModel')
    expect(
      audioGenerateDisabledReason(form, { ...ready, modelLoading: true })
    ).toBe('modelLoading')
    expect(audioGenerateDisabledReason({ ...form, prompt: '  ' }, ready)).toBe(
      'emptyPrompt'
    )
    expect(audioGenerateDisabledReason(form, ready)).toBeNull()
  })

  it('refuses a model that speaks only in a cloned voice', () => {
    expect(
      audioGenerateDisabledReason(form, {
        ...ready,
        capabilities: {
          modelId: QWEN_WIRE,
          mode: 'speech',
          family: 'qwen3_tts',
          task: 'tts',
          params: [],
          voices: [],
          supportsVoiceRef: true,
          requiresVoiceRef: true,
        },
      })
    ).toBe('needsVoiceRef')
  })
})

describe('what a clip shows', () => {
  it('finds a notice by the clip’s model, and none for one that needs none', () => {
    expect(audioAttributionOf(catalog(), SFX_WIRE)).toBe(
      'Powered by Stability AI'
    )
    expect(audioAttributionOf(catalog(), QWEN_WIRE)).toBeNull()
    expect(audioAttributionOf(catalog(), 'gone:q8_0')).toBeNull()
  })

  it('reads a voice id as a name', () => {
    expect(audioVoiceLabel('uncle_fu')).toBe('Uncle Fu')
    expect(audioVoiceLabel('vivian')).toBe('Vivian')
  })
})
