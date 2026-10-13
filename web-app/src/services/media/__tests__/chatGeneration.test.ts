import { describe, expect, it } from 'vitest'

import {
  NoMediaModelError,
  chatMediaSettingsFor,
  resolveChatRequest,
} from '../chatGeneration'
import type {
  MediaCapabilities,
  MediaModelDescriptor,
  MediaProviderDescriptor,
} from '../contract'

const provider = (id: string, enabled = true): MediaProviderDescriptor => ({
  id,
  label: id,
  kind: 'local_engine',
  adapter: 'builtin-engine',
  enabled,
  origin: 'user',
})

const model = (
  id: string,
  provider_id: string,
  task = 'text_to_image'
): MediaModelDescriptor => ({
  id,
  provider_id,
  local_id: id,
  label: id,
  tasks: [task],
  params: {
    [task]: [
      { id: 'prompt', type: 'text', label: 'Prompt' },
      { id: 'steps', type: 'int', label: 'Steps', default: 4 },
    ] as never,
  },
})

const caps = (
  provider_id: string,
  models: MediaModelDescriptor[]
): MediaCapabilities => ({
  contract_version: 2,
  provider_id,
  devices: [],
  models,
})

const base = {
  providers: () => [provider('p')],
  capabilities: () => ({ p: caps('p', [model('p:a', 'p'), model('p:b', 'p')]) }),
  lastUsed: () => undefined,
  newId: () => 'job-1',
}

describe('resolveChatRequest', () => {
  it('uses the last used model and settings with the new prompt', () => {
    const { request } = resolveChatRequest('text_to_image', 'a cat', {
      ...base,
      lastUsed: () => ({
        provider_id: 'p',
        model_id: 'p:b',
        params: { steps: 30, width: 512 },
        device: 'gpu0',
      }),
    })
    expect(request).toMatchObject({
      model_id: 'p:b',
      device: 'gpu0',
      params: { steps: 30, width: 512, prompt: 'a cat' },
    })
  })

  it('falls back to the first model and its defaults when none was used', () => {
    const { request } = resolveChatRequest('text_to_image', 'a cat', base)
    expect(request.model_id).toBe('p:a')
    expect(request.params).toEqual({ steps: 4, prompt: 'a cat' })
  })

  it('ignores a remembered model that is no longer available', () => {
    const { request } = resolveChatRequest('text_to_image', 'x', {
      ...base,
      lastUsed: () => ({ provider_id: 'p', model_id: 'gone', params: { steps: 99 } }),
    })
    expect(request.model_id).toBe('p:a')
    expect(request.params.steps).toBe(4)
  })

  it('says what to do when nothing can make the media', () => {
    expect(() =>
      resolveChatRequest('text_to_video', 'x', base)
    ).toThrow(NoMediaModelError)
    expect(() =>
      resolveChatRequest('text_to_image', 'x', {
        ...base,
        providers: () => [provider('p', false)],
      })
    ).toThrow(/Open Media/)
  })
})

const videoModel = (id: string, provider_id: string): MediaModelDescriptor => ({
  id,
  provider_id,
  local_id: id,
  label: id,
  tasks: ['text_to_video'],
  params: {
    text_to_video: [
      { id: 'prompt', type: 'text', label: 'Prompt' },
      {
        id: 'resolution',
        type: 'resolution',
        label: 'Resolution',
        default: '832x480',
        options: [
          { value: '832x480', width: 832, height: 480 },
          { value: '1280x720', width: 1280, height: 720 },
        ],
      },
      {
        id: 'length_seconds',
        type: 'enum',
        label: 'Length',
        default: 2,
        options: [
          { value: 2, label: '2 seconds' },
          { value: 8, label: '8 seconds' },
        ],
      },
    ] as never,
  },
})

const videoBase = {
  providers: () => [provider('p')],
  capabilities: () => ({ p: caps('p', [videoModel('p:v', 'p')]) }),
  lastUsed: () => undefined,
  newId: () => 'job-1',
}

describe('chatMediaSettingsFor', () => {
  it('reports resolution and length choices plus the highest resolution', () => {
    const settings = chatMediaSettingsFor('text_to_video', videoBase)
    expect(settings.resolutionOptions).toHaveLength(2)
    expect(settings.highestResolution).toBe('1280x720')
    expect(settings.lengthOptions).toHaveLength(2)
    expect(settings.lastUsed).toBeUndefined()
  })

  it('attaches the last used settings when they still resolve', () => {
    const settings = chatMediaSettingsFor('text_to_video', {
      ...videoBase,
      lastUsed: () => ({
        provider_id: 'p',
        model_id: 'p:v',
        params: { length_seconds: 8 },
      }),
    })
    expect(settings.lastUsed).toMatchObject({ model_id: 'p:v' })
  })

  it('throws the same guidance when nothing can make the media', () => {
    expect(() =>
      chatMediaSettingsFor('text_to_image', videoBase)
    ).toThrow(NoMediaModelError)
  })
})

describe('resolveChatRequest overrides', () => {
  it('applies the highest resolution when not using last used', () => {
    const { request } = resolveChatRequest(
      'text_to_video',
      'x',
      videoBase,
      { useLastUsed: false, resolution: 'highest' }
    )
    expect(request.params.resolution).toBe('1280x720')
  })

  it('applies an explicit length for video', () => {
    const { request } = resolveChatRequest(
      'text_to_video',
      'x',
      videoBase,
      { useLastUsed: false, length_seconds: 8 }
    )
    expect(request.params.length_seconds).toBe(8)
  })

  it('ignores overrides when last used settings are used', () => {
    const { request } = resolveChatRequest(
      'text_to_video',
      'x',
      {
        ...videoBase,
        lastUsed: () => ({
          provider_id: 'p',
          model_id: 'p:v',
          params: { length_seconds: 4, resolution: '832x480' },
        }),
      },
      { useLastUsed: true, resolution: 'highest', length_seconds: 8 }
    )
    expect(request.params.length_seconds).toBe(4)
    expect(request.params.resolution).toBe('832x480')
  })
})
