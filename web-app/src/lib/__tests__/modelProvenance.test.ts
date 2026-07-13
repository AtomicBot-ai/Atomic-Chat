import { describe, it, expect } from 'vitest'
import {
  computeProvenanceMarkers,
  readProvenanceStamp,
} from '../modelProvenance'

const stamp = (modelId: string, providerId = 'llamacpp', backend?: string) => ({
  modelProvenance: { modelId, providerId, ...(backend ? { backend } : {}) },
})

const user = (id: string) => ({ id, role: 'user' })
const assistant = (id: string, metadata?: unknown) => ({
  id,
  role: 'assistant',
  metadata,
})

describe('computeProvenanceMarkers', () => {
  it('marks the first stamped response as served, anchored to the prompt', () => {
    const markers = computeProvenanceMarkers([
      user('u1'),
      assistant('a1', stamp('model-a')),
      user('u2'),
      assistant('a2', stamp('model-a')),
    ])

    expect(markers.size).toBe(1)
    expect(markers.get('u1')).toEqual({
      kind: 'served',
      stamp: { modelId: 'model-a', providerId: 'llamacpp' },
    })
  })

  it('does not mark responses when the model never changes', () => {
    const markers = computeProvenanceMarkers([
      user('u1'),
      assistant('a1', stamp('model-a')),
      user('u2'),
      assistant('a2', stamp('model-a')),
      user('u3'),
      assistant('a3', stamp('model-a')),
    ])

    expect([...markers.keys()]).toEqual(['u1'])
  })

  it('marks a model switch, anchored to the prompt that follows the switch', () => {
    const markers = computeProvenanceMarkers([
      user('u1'),
      assistant('a1', stamp('model-a')),
      user('u2'),
      assistant('a2', stamp('model-b')),
    ])

    expect(markers.get('u2')).toEqual({
      kind: 'switched',
      stamp: { modelId: 'model-b', providerId: 'llamacpp' },
    })
  })

  it('anchors a regenerate-with-different-model to the response itself', () => {
    const markers = computeProvenanceMarkers([
      user('u1'),
      assistant('a1', stamp('model-a')),
      assistant('a2', stamp('model-b')),
    ])

    expect(markers.get('a2')).toEqual({
      kind: 'switched',
      stamp: { modelId: 'model-b', providerId: 'llamacpp' },
    })
  })

  it('skips unstamped history and serves at the first stamped response', () => {
    const markers = computeProvenanceMarkers([
      user('u1'),
      assistant('a1'),
      user('u2'),
      assistant('a2', { finishReason: 'stop' }),
      user('u3'),
      assistant('a3', stamp('model-a')),
    ])

    expect([...markers.entries()]).toEqual([
      ['u3', { kind: 'served', stamp: { modelId: 'model-a', providerId: 'llamacpp' } }],
    ])
  })

  it('treats a backend build change as a provenance change', () => {
    const markers = computeProvenanceMarkers([
      user('u1'),
      assistant('a1', stamp('model-a', 'llamacpp', 'turboquant-519f0c5')),
      user('u2'),
      assistant('a2', stamp('model-a', 'llamacpp', 'turboquant-abc1234')),
    ])

    expect(markers.get('u2')?.kind).toBe('switched')
    expect(markers.get('u2')?.stamp.backend).toBe('turboquant-abc1234')
  })

  it('treats a provider change with the same model id as a provenance change', () => {
    const markers = computeProvenanceMarkers([
      user('u1'),
      assistant('a1', stamp('model-a', 'llamacpp')),
      user('u2'),
      assistant('a2', stamp('model-a', 'llamacpp-upstream')),
    ])

    expect(markers.get('u2')?.kind).toBe('switched')
  })

  it('does not collide identities when ids contain spaces', () => {
    // Local GGUF model names can contain spaces; the two stamps below would
    // collide with a space-joined identity key.
    const markers = computeProvenanceMarkers([
      user('u1'),
      assistant('a1', {
        modelProvenance: { modelId: 'model v1', providerId: 'llamacpp', backend: 'beta' },
      }),
      user('u2'),
      assistant('a2', {
        modelProvenance: { modelId: 'model', providerId: 'llamacpp', backend: 'v1 beta' },
      }),
    ])

    expect(markers.get('u2')?.kind).toBe('switched')
  })

  it('ignores malformed stamps', () => {
    const markers = computeProvenanceMarkers([
      user('u1'),
      assistant('a1', { modelProvenance: { modelId: 42 } }),
      assistant('a2', { modelProvenance: 'nope' }),
      assistant('a3', { modelProvenance: { providerId: 'llamacpp' } }),
    ])

    expect(markers.size).toBe(0)
  })
})

describe('readProvenanceStamp', () => {
  it('reads a full stamp', () => {
    expect(
      readProvenanceStamp(stamp('m', 'llamacpp', 'b1'))
    ).toEqual({ modelId: 'm', providerId: 'llamacpp', backend: 'b1' })
  })

  it('omits a non-string backend', () => {
    expect(
      readProvenanceStamp({
        modelProvenance: { modelId: 'm', providerId: 'p', backend: 7 },
      })
    ).toEqual({ modelId: 'm', providerId: 'p' })
  })

  it('returns null for absent or malformed metadata', () => {
    expect(readProvenanceStamp(undefined)).toBeNull()
    expect(readProvenanceStamp({})).toBeNull()
    expect(readProvenanceStamp({ modelProvenance: null })).toBeNull()
    expect(
      readProvenanceStamp({ modelProvenance: { modelId: '', providerId: 'p' } })
    ).toBeNull()
  })
})
