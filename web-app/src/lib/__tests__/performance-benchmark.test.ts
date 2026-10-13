import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareBenchmarkRuns,
  computeBenchmarkStats,
  noiseFloorFor,
  runPerformanceBenchmarks,
  type BenchmarkRun,
} from '../performance-benchmark'

describe('performance benchmark helpers', () => {
  it('computes median, p95, min, max and stddev without inventing zeros', () => {
    expect(computeBenchmarkStats([])).toEqual({
      median: null,
      p95: null,
      min: null,
      max: null,
      stddev: null,
    })

    const stats = computeBenchmarkStats([1, 2, 3, 4, 100])
    expect(stats.median).toBe(3)
    expect(stats.p95).toBe(100)
    expect(stats.min).toBe(1)
    expect(stats.max).toBe(100)
    expect(stats.stddev).toBeTypeOf('number')
  })

  it('respects lower-is-better versus higher-is-better', () => {
    const baseline: BenchmarkRun = {
      runId: 'base',
      at: '2026-01-01T00:00:00.000Z',
      results: [
        {
          id: 'latency',
          name: 'Latency',
          unit: 'ms',
          higherIsBetter: false,
          values: [100, 100, 100],
          samples: 3,
          median: 100,
          p95: 100,
          min: 100,
          max: 100,
          stddev: 0,
        },
        {
          id: 'throughput',
          name: 'Throughput',
          unit: 'tok/s',
          higherIsBetter: true,
          values: [100, 100, 100],
          samples: 3,
          median: 100,
          p95: 100,
          min: 100,
          max: 100,
          stddev: 0,
        },
      ],
    }
    const later: BenchmarkRun = {
      runId: 'later',
      at: '2026-01-02T00:00:00.000Z',
      results: [
        { ...baseline.results[0], values: [80, 80, 80], median: 80 },
        { ...baseline.results[1], values: [80, 80, 80], median: 80 },
      ],
    }

    const comparison = compareBenchmarkRuns(later, baseline)
    expect(comparison.latency.verdict).toBe('better')
    expect(comparison.throughput.verdict).toBe('worse')
  })

  it('derives a wider noise floor for noisy samples', () => {
    expect(
      noiseFloorFor({ median: 100, stddev: 8, samples: 10 })
    ).toBeGreaterThan(noiseFloorFor({ median: 100, stddev: 0.5, samples: 10 }))
  })
})

describe('local API inference benchmark', () => {
  const BASE = 'http://127.0.0.1:1337/v1'

  function sseResponse(records: unknown[]): Response {
    const body = records
      .map((record) => `data: ${JSON.stringify(record)}\n\n`)
      .join('')
    return new Response(`${body}data: [DONE]\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  function stubServer(models: string[]) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({ data: models.map((id) => ({ id })) }),
            { status: 200 }
          )
        }
        return sseResponse([
          { choices: [{ delta: { content: 'Repeatable ' } }] },
          { choices: [{ delta: { content: 'prompts.' } }] },
          { choices: [], usage: { completion_tokens: 3 } },
        ])
      })
    )
    return calls
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('measures only a model a local engine has loaded, never a proxied cloud model', async () => {
    const calls = stubServer(['gpt-4o', 'llama-3.2-3b'])

    const run = await runPerformanceBenchmarks({
      sampleHardware: async () => ({}),
      localApi: {
        baseUrl: BASE,
        apiKey: 'local-secret',
        loadedLocalModels: async () => ['llama-3.2-3b'],
      },
    })

    const chats = calls.filter((call) => call.url.endsWith('/chat/completions'))
    expect(chats).toHaveLength(3)
    for (const chat of chats) {
      expect(JSON.parse(String(chat.init?.body)).model).toBe('llama-3.2-3b')
      expect(chat.init?.headers).toMatchObject({
        Authorization: 'Bearer local-secret',
      })
    }
    const ttft = run.results.find((result) => result.id === 'inference.ttft')
    expect(ttft?.samples).toBe(3)
  })

  it('skips without any request when no local model is loaded', async () => {
    const calls = stubServer(['gpt-4o'])

    const run = await runPerformanceBenchmarks({
      sampleHardware: async () => ({}),
      localApi: { baseUrl: BASE, loadedLocalModels: async () => [] },
    })

    expect(calls).toHaveLength(0)
    const ttft = run.results.find((result) => result.id === 'inference.ttft')
    expect(ttft).toMatchObject({ skipped: true })
    expect(ttft?.reason).toMatch(/Load a local model/)
  })

  it('reports a server that cannot be reached as a skip, not a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )

    const run = await runPerformanceBenchmarks({
      sampleHardware: async () => ({}),
      localApi: { baseUrl: BASE, loadedLocalModels: async () => ['m'] },
    })

    const decode = run.results.find(
      (result) => result.id === 'inference.decode'
    )
    expect(decode).toMatchObject({ skipped: true })
    expect(decode?.reason).toMatch(/could not be reached/)
  })
})
