import { describe, expect, it } from 'vitest'

import { isLocalProvider, LOCAL_PROVIDER_NAMES } from '../registerRemoteProvider'

describe('isLocalProvider', () => {
  it('counts TensorRT-LLM as a local engine, never a remote provider to register', () => {
    // A local engine that slipped into the remote path would be registered with
    // the proxy under its own name and shadow the session the core serves.
    expect(LOCAL_PROVIDER_NAMES).toContain('tensorrt-llm')
    expect(isLocalProvider('tensorrt-llm')).toBe(true)
    expect(LOCAL_PROVIDER_NAMES).toContain('vllm')
    expect(isLocalProvider('vllm')).toBe(true)
    expect(isLocalProvider('nvidia')).toBe(false)
  })
})
