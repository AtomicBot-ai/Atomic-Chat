export interface BenchmarkResult {
  id: string
  name: string
  unit: string
  higherIsBetter: boolean
  values: number[]
  samples: number
  median: number | null
  p95: number | null
  min: number | null
  max: number | null
  stddev: number | null
  skipped?: boolean
  reason?: string
}

export interface BenchmarkRun {
  runId: string
  at: string
  results: BenchmarkResult[]
}

export interface BenchmarkComparison {
  baseline: number
  deltaPct: number
  noiseFloor: number
  verdict: 'better' | 'same' | 'worse'
}

const HISTORY_KEY = 'radium.performance-benchmark.history.v1'
const BASELINE_KEY = 'radium.performance-benchmark.baseline.v1'
const MAX_HISTORY = 20

/**
 * Compute the upper median, nearest-rank P95, extrema, and population standard deviation.
 * Return null statistics for an empty sample without mutating the input.
 */
export function computeBenchmarkStats(values: number[]) {
  if (values.length === 0) {
    return {
      median: null,
      p95: null,
      min: null,
      max: null,
      stddev: null,
    }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length

  return {
    median,
    p95,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stddev: Math.sqrt(variance),
  }
}

/**
 * Return a percentage noise threshold from twice the relative standard deviation.
 * Clamp it to 1–20%, or use 5% when the supplied statistics are insufficient.
 */
export function noiseFloorFor({
  median,
  stddev,
  samples,
}: {
  median: number | null
  stddev: number | null
  samples: number
}): number {
  if (median === null || median === 0 || stddev === null || samples < 2) {
    return 5
  }
  const coefficientOfVariation = Math.abs(stddev / median) * 100
  return Math.min(20, Math.max(1, coefficientOfVariation * 2))
}

/**
 * Compare matching result medians against the baseline and its noise threshold.
 * Skip missing or null medians and zero baselines; respect each metric’s preferred direction.
 */
export function compareBenchmarkRuns(
  run: BenchmarkRun,
  baseline: BenchmarkRun
): Record<string, BenchmarkComparison> {
  const baselineById = new Map(
    baseline.results.map((result) => [result.id, result])
  )
  const comparison: Record<string, BenchmarkComparison> = {}

  for (const result of run.results) {
    const previous = baselineById.get(result.id)
    if (
      !previous ||
      previous.median === null ||
      result.median === null ||
      previous.median === 0
    ) {
      continue
    }

    const deltaPct =
      ((result.median - previous.median) / Math.abs(previous.median)) * 100
    const floor = noiseFloorFor(previous)
    const better = result.higherIsBetter ? deltaPct > 0 : deltaPct < 0

    comparison[result.id] = {
      baseline: previous.median,
      deltaPct: Number(deltaPct.toFixed(1)),
      noiseFloor: Number(floor.toFixed(1)),
      verdict:
        Math.abs(deltaPct) < floor ? 'same' : better ? 'better' : 'worse',
    }
  }

  return comparison
}

/**
 * Combine a metric’s metadata and raw samples with its computed statistics.
 */
function makeResult(
  id: string,
  name: string,
  unit: string,
  higherIsBetter: boolean,
  values: number[]
): BenchmarkResult {
  const stats = computeBenchmarkStats(values)
  return {
    id,
    name,
    unit,
    higherIsBetter,
    values,
    samples: values.length,
    ...stats,
  }
}

/**
 * Represent an unavailable metric with a reason, no samples, and null statistics.
 */
function skippedResult(
  id: string,
  name: string,
  unit: string,
  higherIsBetter: boolean,
  reason: string
): BenchmarkResult {
  return {
    id,
    name,
    unit,
    higherIsBetter,
    values: [],
    samples: 0,
    median: null,
    p95: null,
    min: null,
    max: null,
    stddev: null,
    skipped: true,
    reason,
  }
}

/**
 * Measure sequential hardware sampler calls in milliseconds.
 * Propagate sampler failures so the caller can mark the metric unavailable.
 */
async function runHardwareIpcBenchmark(
  sampleHardware: () => Promise<unknown>,
  iterations = 8
): Promise<BenchmarkResult> {
  const values: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    await sampleHardware()
    values.push(performance.now() - started)
  }
  return makeResult(
    'app.hardwareIpc',
    'Hardware IPC latency',
    'ms',
    false,
    values
  )
}

/**
 * Measure animation-frame intervals in milliseconds, starting at scheduling time.
 * Return a skipped result when requestAnimationFrame is unavailable.
 */
async function runRendererFrameBenchmark(
  frameCount = 30
): Promise<BenchmarkResult> {
  if (typeof requestAnimationFrame !== 'function') {
    return skippedResult(
      'renderer.frameInterval',
      'Renderer frame interval',
      'ms',
      false,
      'requestAnimationFrame is unavailable in this environment.'
    )
  }

  const values: number[] = []
  await new Promise<void>((resolve) => {
    let previous = performance.now()
    const frame = (now: number) => {
      if (values.length > 0 || now > previous) {
        values.push(now - previous)
      }
      previous = now
      if (values.length >= frameCount) {
        resolve()
      } else {
        requestAnimationFrame(frame)
      }
    }
    requestAnimationFrame(frame)
  })

  return makeResult(
    'renderer.frameInterval',
    'Renderer frame interval',
    'ms',
    false,
    values
  )
}

type LocalApiSample = {
  ttftMs: number
  tokensPerSecond: number | null
}

/**
 * Extract nonempty data lines from complete SSE records and retain the unfinished suffix.
 */
function extractSsePayloads(buffer: string): {
  payloads: string[]
  remainder: string
} {
  const parts = buffer.split(/\r?\n\r?\n/)
  const remainder = parts.pop() ?? ''
  const payloads = parts
    .flatMap((part) => part.split(/\r?\n/))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
  return { payloads, remainder }
}

/**
 * Where the inference benchmark sends its requests.
 *
 * The Local API Server also proxies cloud models, so its model list cannot be
 * trusted to mean "on this device": only a model that a local engine has
 * loaded is measured, which keeps the benchmark local-only and free.
 */
export type LocalApiTarget = {
  /** Dial address including the API prefix, e.g. `http://127.0.0.1:1337/v1`. */
  baseUrl: string
  /** The server's API key, when one is configured. */
  apiKey?: string
  /** Ids of the models local engines currently have loaded. */
  loadedLocalModels: () => Promise<string[]>
}

/** Thrown for conditions that skip the inference metrics with a reason. */
class BenchmarkSkip extends Error {}

function authHeaders(target: LocalApiTarget): Record<string, string> {
  return target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}
}

/**
 * The first loaded local model that the server advertises.
 * Network and HTTP failures propagate and become a skip reason.
 */
async function resolveLocalModel(target: LocalApiTarget): Promise<string> {
  const loaded = await target.loadedLocalModels()
  if (loaded.length === 0) {
    throw new BenchmarkSkip(
      'Load a local model to measure time to first token and decode speed.'
    )
  }
  const response = await fetch(`${target.baseUrl}/models`, {
    headers: authHeaders(target),
    signal: AbortSignal.timeout(2500),
  })
  if (response.status === 401 || response.status === 403) {
    throw new BenchmarkSkip('The Local API Server rejected its API key.')
  }
  if (!response.ok) {
    throw new BenchmarkSkip(
      `The Local API Server returned HTTP ${response.status}.`
    )
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: string }>
  }
  const advertised = new Set(
    (payload.data ?? []).flatMap((item) => (item.id ? [item.id] : []))
  )
  const model = loaded.find((id) => advertised.has(id))
  if (!model) {
    throw new BenchmarkSkip(
      'The Local API Server does not list the loaded local model.'
    )
  }
  return model
}

/**
 * Stream a fixed prompt to measure first-text latency and decode throughput.
 * Prefer reported completion tokens, falling back to an estimate from text length.
 * Throw for failed HTTP responses, missing text, or request/stream errors.
 */
async function runLocalApiSample(
  target: LocalApiTarget,
  model: string
): Promise<LocalApiSample> {
  const started = performance.now()
  const response = await fetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(target) },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content:
            'Reply with one short sentence describing why deterministic benchmarks need repeatable prompts.',
        },
      ],
    }),
  })

  if (!response.ok || !response.body) {
    throw new Error(`Local API returned HTTP ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let firstTokenAt: number | null = null
  let outputText = ''
  let completionTokens: number | null = null
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parsed = extractSsePayloads(buffer)
      buffer = parsed.remainder

      for (const payloadText of parsed.payloads) {
        if (payloadText === '[DONE]') continue
        try {
          const payload = JSON.parse(payloadText) as {
            choices?: Array<{ delta?: { content?: string } }>
            usage?: { completion_tokens?: number }
          }
          const text = payload.choices?.[0]?.delta?.content
          if (text) {
            if (firstTokenAt === null) firstTokenAt = performance.now()
            outputText += text
          }
          if (typeof payload.usage?.completion_tokens === 'number') {
            completionTokens = payload.usage.completion_tokens
          }
        } catch {
          // Ignore incomplete/unknown SSE records; the stream parser keeps
          // record boundaries and benchmark correctness does not depend on logs.
        }
      }
    }
  } finally {
    // Stops the server generating when the read failed or timed out; a no-op
    // once the stream has finished.
    void reader.cancel().catch(() => undefined)
  }

  const finished = performance.now()
  if (firstTokenAt === null) {
    throw new Error('Local API stream produced no text tokens.')
  }

  const decodeSeconds = Math.max(0.001, (finished - firstTokenAt) / 1000)
  const tokens =
    completionTokens ?? Math.max(1, Math.round(outputText.length / 4))

  return {
    ttftMs: firstTokenAt - started,
    tokensPerSecond: tokens > 0 ? tokens / decodeSeconds : null,
  }
}

function skippedInference(reason: string): BenchmarkResult[] {
  return [
    skippedResult('inference.ttft', 'Local API TTFT', 'ms', false, reason),
    skippedResult(
      'inference.decode',
      'Local API decode throughput',
      'tok/s',
      true,
      reason
    ),
  ]
}

/**
 * Sample a loaded local model repeatedly for latency and throughput.
 * Keep successful samples; skip both metrics if discovery or every sample fails.
 */
async function runLocalApiBenchmarks(
  target: LocalApiTarget,
  iterations = 3
): Promise<BenchmarkResult[]> {
  try {
    const model = await resolveLocalModel(target)

    const ttft: number[] = []
    const throughput: number[] = []
    let lastError: unknown
    for (let index = 0; index < iterations; index += 1) {
      try {
        const sample = await runLocalApiSample(target, model)
        ttft.push(sample.ttftMs)
        if (sample.tokensPerSecond !== null) {
          throughput.push(sample.tokensPerSecond)
        }
      } catch (error) {
        lastError = error
      }
    }
    if (ttft.length === 0) throw lastError

    return [
      makeResult('inference.ttft', 'Local API TTFT', 'ms', false, ttft),
      makeResult(
        'inference.decode',
        'Local API decode throughput',
        'tok/s',
        true,
        throughput
      ),
    ]
  } catch (error) {
    if (error instanceof BenchmarkSkip) return skippedInference(error.message)
    const detail = error instanceof Error ? ` (${error.message})` : ''
    return skippedInference(
      `The Local API Server could not be reached${detail}. Start it from Settings to measure inference.`
    )
  }
}

/**
 * Run hardware IPC, renderer, and inference benchmarks sequentially with a timestamp.
 * Hardware and inference failures become skipped results.
 */
export async function runPerformanceBenchmarks({
  sampleHardware,
  localApi,
}: {
  sampleHardware: () => Promise<unknown>
  localApi: LocalApiTarget
}): Promise<BenchmarkRun> {
  const results: BenchmarkResult[] = []

  try {
    results.push(await runHardwareIpcBenchmark(sampleHardware))
  } catch (error) {
    results.push(
      skippedResult(
        'app.hardwareIpc',
        'Hardware IPC latency',
        'ms',
        false,
        error instanceof Error ? error.message : 'Hardware IPC is unavailable.'
      )
    )
  }

  results.push(await runRendererFrameBenchmark())
  results.push(...(await runLocalApiBenchmarks(localApi)))

  return {
    runId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
    at: new Date().toISOString(),
    results,
  }
}

/**
 * Load stored benchmark history, returning an empty list for unavailable or invalid storage.
 */
export function loadBenchmarkHistory(): BenchmarkRun[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as BenchmarkRun[]) : []
  } catch {
    return []
  }
}

/**
 * Prepend a run to local history and retain at most 20 entries.
 * Do nothing outside the browser; storage write errors propagate.
 */
export function saveBenchmarkRun(run: BenchmarkRun): void {
  if (typeof window === 'undefined') return
  const history = [run, ...loadBenchmarkHistory()].slice(0, MAX_HISTORY)
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
}

/**
 * Read the saved baseline, returning null when storage is unavailable or JSON is invalid.
 */
export function loadBenchmarkBaseline(): BenchmarkRun | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(BASELINE_KEY)
    return raw ? (JSON.parse(raw) as BenchmarkRun) : null
  } catch {
    return null
  }
}

/**
 * Persist the selected baseline in local storage; do nothing outside the browser.
 * Storage write errors propagate to the caller.
 */
export function saveBenchmarkBaseline(run: BenchmarkRun): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(BASELINE_KEY, JSON.stringify(run))
}
