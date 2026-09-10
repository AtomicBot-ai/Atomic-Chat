import { describe, it, expect } from 'vitest'
import { sortProvidersForSettings } from '../providerOrder'

const order = (names: string[]) =>
  sortProvidersForSettings(names.map((provider) => ({ provider }))).map(
    (p) => p.provider
  )

describe('sortProvidersForSettings', () => {
  it('puts turboquant under mlx when mlx is present (macOS)', () => {
    // Install order the engine manager reports: alphabetical by extension.
    expect(
      order([
        'foundation-models',
        'llamacpp',
        'llamacpp-upstream',
        'mlx',
        'openai',
        'jan',
      ])
    ).toEqual([
      'jan',
      'llamacpp-upstream',
      'mlx',
      'llamacpp',
      'foundation-models',
      'openai',
    ])
  })

  it('puts turboquant under upstream when mlx is filtered out (Windows/Linux)', () => {
    expect(order(['llamacpp', 'llamacpp-upstream', 'openai'])).toEqual([
      'llamacpp-upstream',
      'llamacpp',
      'openai',
    ])
  })

  it('never leaves turboquant first', () => {
    expect(order(['llamacpp', 'llamacpp-upstream'])[0]).toBe(
      'llamacpp-upstream'
    )
    expect(order(['llamacpp', 'mlx'])[0]).toBe('mlx')
  })

  it('sorts unknown providers after the local engines, by title', () => {
    expect(order(['openrouter', 'anthropic', 'llamacpp', 'openai'])).toEqual([
      'llamacpp',
      'anthropic',
      'openai',
      'openrouter',
    ])
  })

  it('does not mutate the input array', () => {
    const input = [{ provider: 'llamacpp' }, { provider: 'llamacpp-upstream' }]
    sortProvidersForSettings(input)
    expect(input.map((p) => p.provider)).toEqual([
      'llamacpp',
      'llamacpp-upstream',
    ])
  })
})
