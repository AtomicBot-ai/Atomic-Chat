import { describe, expect, it } from 'vitest'

import { integrationsFor } from '@/constants/integrations'

import {
  editorClipboardText,
  editorWarnings,
  vscodeLanguageModelEntry,
} from '../integration-editor-setup'

const agent = (id: string) =>
  integrationsFor('macos').find((a) => a.id === id)!

const connection = {
  baseUrl: 'http://127.0.0.1:1337/v1',
  apiKey: 'sk-local',
  model: 'qwen3.5-9b',
  contextLength: 32768,
}

describe('VS Code chatLanguageModels.json entry', () => {
  it('is a Custom Endpoint on Chat Completions with the served window', () => {
    expect(vscodeLanguageModelEntry(connection)).toEqual({
      name: 'Atomic Chat',
      vendor: 'customendpoint',
      apiType: 'chat-completions',
      models: [
        {
          id: 'qwen3.5-9b',
          name: 'qwen3.5-9b',
          url: 'http://127.0.0.1:1337/v1/chat/completions',
          toolCalling: true,
          vision: false,
          maxInputTokens: 32768,
          maxOutputTokens: 8192,
        },
      ],
    })
  })

  it('caps output at a quarter of a small window and omits an unknown one', () => {
    const small = vscodeLanguageModelEntry({
      ...connection,
      contextLength: 16384,
    }).models[0]
    expect(small.maxInputTokens).toBe(16384)
    expect(small.maxOutputTokens).toBe(4096)

    const unknown = vscodeLanguageModelEntry({
      ...connection,
      contextLength: undefined,
    }).models[0]
    expect(unknown).not.toHaveProperty('maxInputTokens')
    expect(unknown).not.toHaveProperty('maxOutputTokens')
  })

  it('is what Copy settings copies, as JSON without the API key', () => {
    const text = editorClipboardText(agent('vscode'), connection)
    expect(JSON.parse(text)).toEqual(vscodeLanguageModelEntry(connection))
    expect(text).not.toContain('sk-local')
  })
})

describe('editorClipboardText', () => {
  it('gives Xcode only the port its Locally Hosted provider asks for', () => {
    expect(editorClipboardText(agent('xcode'), connection)).toBe('Port: 1337')
  })

  it('adds the context window for JetBrains to set by hand', () => {
    expect(editorClipboardText(agent('jetbrains'), connection)).toBe(
      [
        'Base URL: http://127.0.0.1:1337/v1',
        'API key: sk-local',
        'Model: qwen3.5-9b',
        'Context window: 32768',
      ].join('\n')
    )
    expect(
      editorClipboardText(agent('jetbrains'), {
        ...connection,
        model: null,
        contextLength: undefined,
      })
    ).toBe(
      [
        'Base URL: http://127.0.0.1:1337/v1',
        'API key: sk-local',
        'Model: (load a model in a chat first)',
      ].join('\n')
    )
  })
})

describe('editorWarnings', () => {
  it('warns Xcode users about a server key and a prefix other than /v1', () => {
    expect(
      editorWarnings(agent('xcode'), { apiKey: 'sk', apiPrefix: '/api' })
    ).toEqual([
      { key: 'launch:editorWarnings.xcodeApiKey' },
      { key: 'launch:editorWarnings.xcodePrefix', values: { prefix: '/api' } },
    ])
    expect(
      editorWarnings(agent('xcode'), { apiKey: '', apiPrefix: '/v1' })
    ).toEqual([])
    expect(
      editorWarnings(agent('xcode'), { apiKey: '', apiPrefix: '/v1/' })
    ).toEqual([])
  })

  it('has nothing to say about editors with a key field and a URL', () => {
    for (const id of ['vscode', 'jetbrains']) {
      expect(
        editorWarnings(agent(id), { apiKey: 'sk', apiPrefix: '/api' })
      ).toEqual([])
    }
  })
})
