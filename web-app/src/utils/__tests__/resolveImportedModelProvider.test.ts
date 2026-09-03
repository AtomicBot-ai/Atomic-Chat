import { describe, expect, it } from 'vitest'
import { resolveImportedModelProvider } from '../resolveImportedModelProvider'

const shared = { models: [{ id: 'owner/model' }] }
const turboquant = { provider: 'llamacpp', active: true, ...shared }
const upstream = { provider: 'llamacpp-upstream', active: true, ...shared }
const mlx = { provider: 'mlx', active: true, models: [{ id: 'mlx-model' }] }
const openai = { provider: 'openai', active: true, models: [{ id: 'gpt' }] }

describe('resolveImportedModelProvider', () => {
  it('prefers the selected local provider over array order', () => {
    expect(
      resolveImportedModelProvider('owner/model', [turboquant, upstream], {
        selectedProvider: 'llamacpp-upstream',
      })?.provider
    ).toBe('llamacpp-upstream')
  })

  it('falls back to the importing engine when the selection is a cloud provider', () => {
    expect(
      resolveImportedModelProvider(
        'owner/model',
        [openai, turboquant, upstream],
        { selectedProvider: 'openai', eventProvider: 'llamacpp' }
      )?.provider
    ).toBe('llamacpp')
  })

  it('falls back to the default local provider, then to array order', () => {
    expect(
      resolveImportedModelProvider('owner/model', [turboquant, upstream])
        ?.provider
    ).toBe('llamacpp-upstream')
    expect(
      resolveImportedModelProvider('owner/model', [
        turboquant,
        { ...upstream, active: false },
      ])?.provider
    ).toBe('llamacpp')
  })

  it('skips deactivated providers and matches the backslash id variant', () => {
    expect(
      resolveImportedModelProvider(
        'owner/model',
        [
          { ...turboquant, active: false },
          { provider: 'llamacpp-upstream', models: [{ id: 'owner\\model' }] },
        ],
        { selectedProvider: 'llamacpp' }
      )?.provider
    ).toBe('llamacpp-upstream')
  })

  it('returns the default local provider entry when nobody lists the model', () => {
    expect(
      resolveImportedModelProvider('unknown', [mlx, upstream, openai])?.provider
    ).toBe('llamacpp-upstream')
    expect(resolveImportedModelProvider('unknown', [mlx, openai])).toBeUndefined()
  })
})
