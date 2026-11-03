import { describe, expect, it } from 'vitest'

import en from '@/locales/en/launch.json'
import fr from '@/locales/fr/launch.json'

import { INTEGRATION_AGENTS, integrationsFor } from '../integrations'

const ids = (platform: Parameters<typeof integrationsFor>[0]) =>
  integrationsFor(platform).map((agent) => agent.id)

/** The string a `launch:a.b.c` key names in a launch.json, if any. */
const lookup = (locale: unknown, key: string): unknown =>
  key
    .replace(/^launch:/, '')
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      locale
    )

describe('integration catalog', () => {
  it('offers Xcode on macOS only', () => {
    expect(ids('macos')).toContain('xcode')
    expect(ids('windows')).not.toContain('xcode')
    expect(ids('linux')).not.toContain('xcode')
    // Every other editor exists everywhere.
    for (const platform of ['windows', 'linux'] as const) {
      expect(ids(platform)).toEqual(
        expect.arrayContaining(['vscode', 'jetbrains', 'zed', 'zcode'])
      )
    }
  })

  it('hides nothing when the platform is unknown', () => {
    expect(ids(null)).toContain('xcode')
    expect(ids(null)).toHaveLength(ids('macos').length)
  })

  it('detects Xcode by its app, not the xed shim every Mac has', () => {
    const xcode = integrationsFor('macos').find((a) => a.id === 'xcode')!
    expect(xcode.detectBin).toBe('xcode')
    expect(xcode.docsUrl).toBe(
      'https://developer.apple.com/documentation/xcode/setting-up-coding-intelligence'
    )
  })

  it('names editor steps that exist in English and French', () => {
    const editors = integrationsFor('macos').filter((a) => a.editor)
    expect(editors.map((a) => a.id)).toEqual(['vscode', 'jetbrains', 'xcode'])
    for (const agent of editors) {
      expect(agent.editor!.steps.length).toBeGreaterThan(0)
      for (const step of agent.editor!.steps) {
        expect(typeof lookup(en, step), step).toBe('string')
        expect(typeof lookup(fr, step), step).toBe('string')
      }
    }
  })

  it('walks VS Code through Custom Endpoint, not the deprecated OpenAI Compatible', () => {
    const steps = integrationsFor('macos')
      .find((a) => a.id === 'vscode')!
      .editor!.steps.map((step) => lookup(en, step) as string)
      .join(' ')
    expect(steps).toContain('Chat: Manage Language Models')
    expect(steps).toContain('Custom Endpoint')
    expect(steps).toContain('chatLanguageModels.json')
    expect(steps).not.toContain('OpenAI Compatible')
  })

  it('points JetBrains users at Providers & API keys and manual assignment', () => {
    const steps = integrationsFor('macos')
      .find((a) => a.id === 'jetbrains')!
      .editor!.steps.map((step) => lookup(en, step) as string)
      .join(' ')
    expect(steps).toContain(
      'Settings | Tools | AI Assistant | Providers & API keys'
    )
    expect(steps).toContain('Tool calling')
    expect(steps).toContain('Core features')
    expect(steps).toContain("agents can't use local models")
  })

  it('names Xcode’s own button', () => {
    const steps = integrationsFor('macos')
      .find((a) => a.id === 'xcode')!
      .editor!.steps.map((step) => lookup(en, step) as string)
      .join(' ')
    expect(steps).toContain('Add a Chat Provider')
    expect(steps).toContain('Locally Hosted')
  })

  it('builds the exported catalog for the platform under test', () => {
    // Vitest runs with every IS_* flag false: no platform, nothing hidden.
    expect(INTEGRATION_AGENTS.map((agent) => agent.id)).toEqual(ids(null))
  })
})
