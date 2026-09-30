import { describe, it, expect } from 'vitest'
import {
  OUT_OF_CONTEXT_SIZE,
  MODEL_ACCESS_DENIED_TITLE,
  MODEL_ACCESS_DENIED_MESSAGE,
  AUTHENTICATION_FAILED_TITLE,
  AUTHENTICATION_FAILED_MESSAGE,
  isAuthenticationError,
  isModelAccessError,
  isOutOfMemoryError,
} from '../error'

describe('error utilities', () => {
  describe('OUT_OF_CONTEXT_SIZE', () => {
    it('should have correct error message', () => {
      expect(OUT_OF_CONTEXT_SIZE).toBe(
        'the request exceeds the available context size.'
      )
    })

    it('should be a string', () => {
      expect(typeof OUT_OF_CONTEXT_SIZE).toBe('string')
    })
  })

  describe('MODEL_ACCESS_DENIED constants', () => {
    it('exposes a user-friendly title and message', () => {
      expect(MODEL_ACCESS_DENIED_TITLE).toBe('Model not available for your API key')
      expect(MODEL_ACCESS_DENIED_MESSAGE).toContain(
        'enabled in your provider'
      )
      expect(MODEL_ACCESS_DENIED_MESSAGE).toContain('allowed models list')
    })
  })

  describe('AUTHENTICATION_FAILED constants', () => {
    it('exposes clear API-key guidance', () => {
      expect(AUTHENTICATION_FAILED_TITLE).toBe('Authentication failed')
      expect(AUTHENTICATION_FAILED_MESSAGE).toContain(
        'API key is correct and active'
      )
    })
  })

  describe('isAuthenticationError', () => {
    const positives: Array<[string, unknown]> = [
      ['401 message', 'Request failed with status code 401'],
      ['403 response field', { response: { status: 403 } }],
      ['top-level numeric status', { status: 401, message: 'Request failed' }],
      ['NVIDIA invalid key', 'Unauthorized: invalid API key'],
      ['OpenAI incorrect key', 'Incorrect API key provided'],
      ['Anthropic auth envelope', { type: 'authentication_error' }],
      ['nested cause', { cause: { code: 401 } }],
      ['invalid bearer token', 'Invalid bearer token'],
      ['bad credentials', 'Bad credentials'],
    ]

    it.each(positives)('detects %s', (_label, error) => {
      expect(isAuthenticationError(error)).toBe(true)
    })

    const negatives: Array<[string, unknown]> = [
      ['empty string', ''],
      ['network failure', new Error('fetch failed: ECONNREFUSED')],
      ['rate limit', { status: 429, message: 'Rate limit exceeded' }],
      ['server failure', { response: { status: 500 } }],
      ['context size', OUT_OF_CONTEXT_SIZE],
      ['missing object fields', {}],
      ['null', null],
    ]

    it.each(negatives)('does not match %s', (_label, error) => {
      expect(isAuthenticationError(error)).toBe(false)
    })

    it('handles circular provider error objects safely', () => {
      const error: Record<string, unknown> = { status: 401 }
      error.response = error
      expect(isAuthenticationError(error)).toBe(true)
    })
  })

  describe('isModelAccessError', () => {
    const positives: Array<[string, string]> = [
      [
        'openai model_not_found',
        'The model `gpt-5.4` does not exist or you do not have access to it.',
      ],
      [
        'openai code string',
        'Error: model_not_found - project lacks access',
      ],
      [
        'anthropic permission scoped to model',
        'permission_error: your API key does not have permission to use this model',
      ],
      [
        'gemini permission denied',
        'PERMISSION_DENIED: Caller does not have permission to access model',
      ],
      [
        'xai style not authorized',
        'Not authorized to invoke model grok-4-1-fast-reasoning',
      ],
      [
        'plain english',
        "You don't have access to this model yet.",
      ],
      [
        'model not available',
        'Model not available for this API key',
      ],
    ]

    it.each(positives)('detects %s', (_label, message) => {
      expect(isModelAccessError(new Error(message))).toBe(true)
      expect(isModelAccessError(message)).toBe(true)
      expect(isModelAccessError({ message })).toBe(true)
    })

    const negatives: Array<[string, string]> = [
      ['empty string', ''],
      ['context size', OUT_OF_CONTEXT_SIZE],
      ['network failure', 'fetch failed: ECONNREFUSED'],
      ['rate limit', 'Rate limit exceeded, please retry later'],
      ['generic 500', 'Internal server error'],
      ['unrelated 404', 'Thread not found'],
    ]

    it.each(negatives)('does not match %s', (_label, message) => {
      expect(isModelAccessError(message ? new Error(message) : message)).toBe(
        false
      )
    })

    it('handles null / undefined safely', () => {
      expect(isModelAccessError(null)).toBe(false)
      expect(isModelAccessError(undefined)).toBe(false)
      expect(isModelAccessError({})).toBe(false)
    })
  })

  describe('isOutOfMemoryError', () => {
    const positives: Array<[string, string]> = [
      ['raw metal compute error', 'Compute error'],
      [
        'proxy insufficient_memory envelope',
        'The model ran out of memory while processing this request. Try a smaller or lighter model.',
      ],
      ['cuda oom', 'ggml_cuda: CUDA_ERROR_OUT_OF_MEMORY'],
      ['vulkan oom', 'ErrorOutOfDeviceMemory'],
      ['alloc failure', 'failed to allocate buffer'],
      ['insufficient memory', 'error: Insufficient Memory'],
    ]

    it.each(positives)('detects %s', (_label, message) => {
      expect(isOutOfMemoryError(new Error(message))).toBe(true)
      expect(isOutOfMemoryError(message)).toBe(true)
      expect(isOutOfMemoryError({ message })).toBe(true)
    })

    const negatives: Array<[string, string]> = [
      ['empty string', ''],
      ['context size', OUT_OF_CONTEXT_SIZE],
      ['rate limit', 'Rate limit exceeded'],
      ['generic 500', 'Internal server error'],
    ]

    it.each(negatives)('does not match %s', (_label, message) => {
      expect(isOutOfMemoryError(message ? new Error(message) : message)).toBe(
        false
      )
    })

    it('handles null / undefined safely', () => {
      expect(isOutOfMemoryError(null)).toBe(false)
      expect(isOutOfMemoryError(undefined)).toBe(false)
      expect(isOutOfMemoryError({})).toBe(false)
    })
  })
})
