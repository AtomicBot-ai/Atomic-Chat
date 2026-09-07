import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  attachmentExt,
  chatHttpStatus,
  classifyChatFailure,
  classifyModelLoadFailure,
  ctxUsedBucket,
  ctxUsedPercent,
  finalizeChatTurnOnce,
  lengthBucket,
  markModelDownloaded,
  modelLoadSource,
  normalizeModelId,
  resetDownloadedModelsForTests,
  resetModelLoadThrottlesForTests,
  shouldEmitChatFailure,
  shouldEmitModelLoadSuccess,
  toolNameForAnalytics,
} from '@/lib/telemetry'

describe('lengthBucket', () => {
  it('separates unknown from genuinely empty', () => {
    expect(lengthBucket(null)).toBe('unknown')
    expect(lengthBucket(undefined)).toBe('unknown')
    expect(lengthBucket(-1)).toBe('unknown')
    // A tool-only response really is zero-length; that is not "unknown".
    expect(lengthBucket(0)).toBe('empty')
  })

  it('buckets on the documented boundaries', () => {
    expect(lengthBucket(1)).toBe('lt_100')
    expect(lengthBucket(99)).toBe('lt_100')
    expect(lengthBucket(100)).toBe('100_500')
    expect(lengthBucket(499)).toBe('100_500')
    expect(lengthBucket(500)).toBe('500_2k')
    expect(lengthBucket(1999)).toBe('500_2k')
    expect(lengthBucket(2000)).toBe('2k_10k')
    expect(lengthBucket(9999)).toBe('2k_10k')
    expect(lengthBucket(10000)).toBe('gt_10k')
  })

  it('never returns a number, so an exact length cannot leak', () => {
    for (const n of [7, 123, 4096, 999999]) {
      expect(typeof lengthBucket(n)).toBe('string')
      expect(String(lengthBucket(n))).not.toContain(String(n))
    }
  })
})

describe('ctxUsedBucket', () => {
  it('handles unknown and out-of-range input', () => {
    expect(ctxUsedBucket(null)).toBe('unknown')
    expect(ctxUsedBucket(undefined)).toBe('unknown')
    expect(ctxUsedBucket(NaN)).toBe('unknown')
    expect(ctxUsedBucket(-5)).toBe('unknown')
  })

  it('buckets on the documented boundaries', () => {
    expect(ctxUsedBucket(0)).toBe('lt_25')
    expect(ctxUsedBucket(24.9)).toBe('lt_25')
    expect(ctxUsedBucket(25)).toBe('25_50')
    expect(ctxUsedBucket(50)).toBe('50_75')
    expect(ctxUsedBucket(75)).toBe('75_90')
    expect(ctxUsedBucket(90)).toBe('90_100')
    expect(ctxUsedBucket(100)).toBe('90_100')
    // Auto-increase means reported usage can exceed the configured window.
    expect(ctxUsedBucket(140)).toBe('gt_100')
  })
})

describe('ctxUsedPercent', () => {
  it('returns null when either side is unknown or the window is zero', () => {
    expect(ctxUsedPercent(null, 4096)).toBeNull()
    expect(ctxUsedPercent(1000, null)).toBeNull()
    expect(ctxUsedPercent(1000, 0)).toBeNull()
  })

  it('computes percent used', () => {
    expect(ctxUsedPercent(2048, 4096)).toBe(50)
  })
})

describe('attachmentExt', () => {
  it('returns allow-listed extensions', () => {
    expect(attachmentExt('diagram.png')).toBe('png')
    expect(attachmentExt('notes.PDF')).toBe('pdf')
    expect(attachmentExt('voice.mp3')).toBe('mp3')
    expect(attachmentExt('main.rs')).toBe('rs')
  })

  it('collapses anything unrecognised to "other"', () => {
    expect(attachmentExt('backup.sqlite3')).toBe('other')
    expect(attachmentExt('Makefile')).toBe('other')
    expect(attachmentExt('')).toBe('other')
    expect(attachmentExt(null)).toBe('other')
    expect(attachmentExt(undefined)).toBe('other')
  })

  it('never returns any part of the filename or path', () => {
    const secrets = [
      '/Users/alice/Documents/2026-severance-agreement.pdf',
      'C:\\Users\\bob\\my-startup-cap-table.xlsx',
      'patient-record-jane-doe.docx',
      'nda-with-acme.unknownext',
    ]
    for (const path of secrets) {
      const ext = attachmentExt(path)
      expect(ext.length).toBeLessThanOrEqual(5)
      expect(path.toLowerCase()).not.toBe(ext)
      // The stem must not survive in any form.
      expect(ext).not.toMatch(/alice|bob|jane|doe|severance|cap-table|acme/)
    }
    expect(attachmentExt(secrets[0])).toBe('pdf')
    expect(attachmentExt(secrets[3])).toBe('other')
  })
})

describe('toolNameForAnalytics', () => {
  const builtin = new Set(['retrieve_documents', 'search_web'])

  it('passes built-in tools through by name', () => {
    expect(toolNameForAnalytics('retrieve_documents', builtin)).toBe(
      'retrieve_documents'
    )
  })

  it('hashes anything not on the allow-list', () => {
    // A user's MCP server name can itself describe their internal systems.
    const hashed = toolNameForAnalytics('acmecorp_payroll_query', builtin)
    expect(hashed).toMatch(/^mcp_[0-9a-f]{8}$/)
    expect(hashed).not.toContain('acmecorp')
    expect(hashed).not.toContain('payroll')
  })

  it('is stable, so cohorts still work across sessions', () => {
    expect(toolNameForAnalytics('internal_tool', builtin)).toBe(
      toolNameForAnalytics('internal_tool', builtin)
    )
    expect(toolNameForAnalytics('a_tool', builtin)).not.toBe(
      toolNameForAnalytics('b_tool', builtin)
    )
  })

  it('hashes when no allow-list is supplied', () => {
    expect(toolNameForAnalytics('anything')).toMatch(/^mcp_[0-9a-f]{8}$/)
    expect(toolNameForAnalytics('')).toBe('unknown')
  })
})

describe('chatHttpStatus', () => {
  it('reads the download-layer wording', () => {
    expect(chatHttpStatus('HTTP status 404 while fetching')).toBe(404)
  })

  it('reads common provider phrasings', () => {
    expect(chatHttpStatus('Request failed with status code 429')).toBe(429)
    expect(chatHttpStatus('http 503 service unavailable')).toBe(503)
  })

  it('returns null when there is no status', () => {
    expect(chatHttpStatus('something went wrong')).toBeNull()
    expect(chatHttpStatus(null)).toBeNull()
  })
})

describe('classifyChatFailure', () => {
  it.each([
    ['The operation was aborted', 'aborted'],
    ['Request cancelled by user', 'aborted'],
    ['blocked by content filter', 'content_filter'],
    ['the request exceeds the available context size.', 'context_overflow'],
    ['n_ctx exceeded: context length too long', 'context_overflow'],
    ['ggml-metal: out of memory', 'oom'],
    ['CUDA_ERROR_OUT_OF_MEMORY', 'oom'],
    ['The model `gpt-9` does not exist or you do not have access to it', 'model_access'],
    ['Request failed with status code 401', 'auth'],
    ['Request failed with status code 429', 'rate_limit'],
    ['fetch failed: ECONNREFUSED 127.0.0.1:1337', 'model_unreachable'],
    ['no model loaded', 'model_load_failed'],
    ['request timed out after 60s', 'timeout'],
    ['Request failed with status code 500', 'server_error'],
    ['Request failed with status code 400', 'bad_request'],
    ['dns lookup failed', 'network'],
    ['something inexplicable happened', 'unknown'],
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyChatFailure(message)).toBe(expected)
  })

  it('accepts Error instances and objects with a message', () => {
    expect(classifyChatFailure(new Error('Aborted'))).toBe('aborted')
    expect(classifyChatFailure({ message: 'status code 429' })).toBe(
      'rate_limit'
    )
  })

  it('returns unknown for empty input', () => {
    expect(classifyChatFailure(null)).toBe('unknown')
    expect(classifyChatFailure(undefined)).toBe('unknown')
    expect(classifyChatFailure('')).toBe('unknown')
  })

  it('prefers abort over any other signal', () => {
    // A cancelled request often carries a misleading connection error too.
    expect(classifyChatFailure('aborted: ECONNREFUSED')).toBe('aborted')
  })
})

describe('finalizeChatTurnOnce', () => {
  it('admits a turn id exactly once', () => {
    const id = `turn-${Math.random()}`
    expect(finalizeChatTurnOnce(id)).toBe(true)
    expect(finalizeChatTurnOnce(id)).toBe(false)
    expect(finalizeChatTurnOnce(id)).toBe(false)
  })

  it('treats distinct turns independently', () => {
    expect(finalizeChatTurnOnce(`a-${Math.random()}`)).toBe(true)
    expect(finalizeChatTurnOnce(`b-${Math.random()}`)).toBe(true)
  })

  it('rejects an empty id rather than deduping every turn together', () => {
    expect(finalizeChatTurnOnce('')).toBe(false)
  })
})

describe('shouldEmitChatFailure', () => {
  it('throttles an identical (model, kind) pair inside the window', () => {
    const model = `model-${Math.random()}`
    expect(shouldEmitChatFailure(model, 'oom')).toBe(true)
    expect(shouldEmitChatFailure(model, 'oom')).toBe(false)
  })

  it('does not throttle a different failure kind on the same model', () => {
    const model = `model-${Math.random()}`
    expect(shouldEmitChatFailure(model, 'oom')).toBe(true)
    expect(shouldEmitChatFailure(model, 'network')).toBe(true)
  })

  it('keys a missing model id consistently', () => {
    expect(shouldEmitChatFailure(null, 'unknown')).toBe(true)
    expect(shouldEmitChatFailure(undefined, 'unknown')).toBe(false)
  })
})

describe('normalizeModelId', () => {
  it('makes one model one string across platforms', () => {
    // Local ids are minted by slicing a filesystem path, so Windows builds
    // older than 06eafa9f1 produced the backslash spelling — and PostHog read
    // the two as different models, one at 11.8% download success and the
    // other at 95.1%.
    expect(normalizeModelId('unsloth\\gemma-4-E4B-it-IQ4_XS')).toBe(
      'unsloth/gemma-4-E4B-it-IQ4_XS'
    )
    expect(normalizeModelId('unsloth/gemma-4-E4B-it-IQ4_XS')).toBe(
      'unsloth/gemma-4-E4B-it-IQ4_XS'
    )
  })

  it('handles nested paths and absent ids', () => {
    expect(normalizeModelId('a\\b\\c')).toBe('a/b/c')
    expect(normalizeModelId(null)).toBeNull()
    expect(normalizeModelId('')).toBeNull()
  })
})

describe('classifyModelLoadFailure', () => {
  it('calls a macOS Metal OOM an OOM', () => {
    // 2251 events across 124 devices arrive as LLAMA_CPP_PROCESS_ERROR with
    // the cause only in the stderr tail, against 16 carrying OUT_OF_MEMORY —
    // so anything keyed on the code alone was blind to the platform.
    expect(
      classifyModelLoadFailure(
        'LLAMA_CPP_PROCESS_ERROR',
        'ggml_metal_graph_compute: command buffer 0 failed',
        true
      )
    ).toBe('oom')
  })

  it('trusts the code when there is one', () => {
    expect(classifyModelLoadFailure('BINARY_NOT_FOUND', null, false)).toBe(
      'binary_missing'
    )
    expect(
      classifyModelLoadFailure('LOCAL_API_SERVER_START_TIMEOUT', null, false)
    ).toBe('timeout')
    expect(
      classifyModelLoadFailure('MODEL_ARCH_NOT_SUPPORTED', null, false)
    ).toBe('arch_unsupported')
  })

  it('still classifies the 68% of failures that carry no code', () => {
    expect(
      classifyModelLoadFailure(null, 'llama-server: no such file', false)
    ).toBe('binary_missing')
    expect(
      classifyModelLoadFailure(null, 'model.gguf: no such file', false)
    ).toBe('model_file_missing')
    expect(
      classifyModelLoadFailure(null, 'unknown projector type: foo', false)
    ).toBe('arch_unsupported')
    expect(classifyModelLoadFailure(null, 'process exited with 139', false)).toBe(
      'process_crash'
    )
  })

  it('says unknown rather than guessing', () => {
    expect(classifyModelLoadFailure(null, null, false)).toBe('unknown')
    expect(classifyModelLoadFailure('SOMETHING_NEW', 'odd', false)).toBe(
      'unknown'
    )
  })
})

describe('model_source', () => {
  beforeEach(() => {
    resetDownloadedModelsForTests()
  })

  it('remembers a download across app restarts', () => {
    markModelDownloaded('unsloth/gemma-4-E4B-it-IQ4_XS')

    // The marker used to live in memory only, so a model downloaded yesterday
    // reported `local_disk` today and `local_disk` could not be read as "the
    // user imported this".
    expect(modelLoadSource('unsloth/gemma-4-E4B-it-IQ4_XS')).toBe('download')
    expect(
      JSON.parse(localStorage.getItem('telemetry-downloaded-models') ?? '[]')
    ).toHaveLength(1)
  })

  it('matches the same model across path separators', () => {
    markModelDownloaded('unsloth/gemma-4-E4B-it-IQ4_XS')

    expect(modelLoadSource('unsloth\\gemma-4-E4B-it-IQ4_XS')).toBe('download')
  })

  it('reports anything unseen as already on disk', () => {
    expect(modelLoadSource('never/downloaded')).toBe('local_disk')
  })
})

describe('shouldEmitModelLoadSuccess', () => {
  beforeEach(() => {
    resetModelLoadThrottlesForTests()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  it('bounds an oscillating load that keeps succeeding', () => {
    // Only failures were throttled, which is how one device came to produce
    // 62.9% of every model_load event in the project.
    expect(shouldEmitModelLoadSuccess('m', 'llamacpp')).toBe(true)
    expect(shouldEmitModelLoadSuccess('m', 'llamacpp')).toBe(false)

    vi.advanceTimersByTime(61_000)
    expect(shouldEmitModelLoadSuccess('m', 'llamacpp')).toBe(true)
    vi.useRealTimers()
  })

  it('keeps a different model or backend separate', () => {
    expect(shouldEmitModelLoadSuccess('m', 'llamacpp')).toBe(true)
    expect(shouldEmitModelLoadSuccess('other', 'llamacpp')).toBe(true)
    expect(shouldEmitModelLoadSuccess('m', 'mlx')).toBe(true)
    vi.useRealTimers()
  })

  it('evicts oldest-first instead of forgetting everything at once', () => {
    // The old `clear()` on overflow meant a device with many models wiped its
    // whole window and started emitting freely — the exact devices the
    // throttle exists to bound.
    expect(shouldEmitModelLoadSuccess('first', 'llamacpp')).toBe(true)
    for (let i = 0; i < 500; i += 1) {
      shouldEmitModelLoadSuccess(`filler-${i}`, 'llamacpp')
    }

    // `first` was evicted, so it is emittable again — but the most recent
    // entries are still held.
    expect(shouldEmitModelLoadSuccess('filler-499', 'llamacpp')).toBe(false)
    vi.useRealTimers()
  })
})
