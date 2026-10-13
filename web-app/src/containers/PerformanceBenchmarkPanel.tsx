import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { getLocalApiServerUrl } from '@/utils/localApiServerControl'
import {
  compareBenchmarkRuns,
  loadBenchmarkBaseline,
  runPerformanceBenchmarks,
  saveBenchmarkBaseline,
  saveBenchmarkRun,
  type BenchmarkRun,
} from '@/lib/performance-benchmark'

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '—'
  const digits = unit === 'tok/s' ? 1 : 2
  return `${value.toFixed(digits)} ${unit}`
}

export function PerformanceBenchmarkPanel() {
  const serviceHub = useServiceHub()
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<BenchmarkRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<BenchmarkRun | null>(() =>
    loadBenchmarkBaseline()
  )
  const comparison = useMemo(
    () => (run && baseline ? compareBenchmarkRuns(run, baseline) : {}),
    [run, baseline]
  )

  const runBenchmarks = async () => {
    setRunning(true)
    setError(null)
    try {
      const next = await runPerformanceBenchmarks({
        sampleHardware: () => serviceHub.hardware().getSystemUsage(),
        localApi: {
          baseUrl: getLocalApiServerUrl(),
          apiKey: useLocalApiServer.getState().apiKey || undefined,
          loadedLocalModels: () => serviceHub.models().getActiveModels(),
        },
      })
      setRun(next)
      saveBenchmarkRun(next)
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The benchmark failed.'
      )
    } finally {
      setRunning(false)
    }
  }

  const makeBaseline = () => {
    if (!run) return
    setBaseline(run)
    try {
      saveBenchmarkBaseline(run)
    } catch (failure) {
      setError(
        failure instanceof Error
          ? `The baseline could not be saved: ${failure.message}`
          : 'The baseline could not be saved.'
      )
    }
  }

  return (
    <div className="mt-6 bg-secondary/50 rounded-lg p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold">Performance benchmark</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Explicit, local-only checks for hardware IPC, renderer frame time,
            local API time to first token, and decode throughput.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={runBenchmarks} disabled={running}>
            {running ? 'Running…' : 'Run benchmark'}
          </Button>
          <Button
            variant="outline"
            onClick={makeBaseline}
            disabled={!run || running}
          >
            Set baseline
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive mb-3">
          {error}
        </p>
      )}

      {!run ? (
        <p className="text-sm text-muted-foreground">
          Heavy or synthetic workloads do not run automatically. Start a run
          when you want a comparable snapshot.
        </p>
      ) : (
        <div className="space-y-3">
          {run.results.map((result) => {
            const delta = comparison[result.id]
            return (
              <div
                key={result.id}
                className="border border-border/60 rounded-md px-4 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{result.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {result.skipped
                        ? result.reason
                        : `${result.samples} samples · p95 ${formatValue(
                            result.p95,
                            result.unit
                          )}`}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold">
                      {formatValue(result.median, result.unit)}
                    </div>
                    {delta && (
                      <div
                        className={
                          delta.verdict === 'better'
                            ? 'text-xs text-green-600 dark:text-green-400'
                            : delta.verdict === 'worse'
                              ? 'text-xs text-red-600 dark:text-red-400'
                              : 'text-xs text-muted-foreground'
                        }
                      >
                        {delta.deltaPct > 0 ? '+' : ''}
                        {delta.deltaPct}% vs baseline · {delta.verdict}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default PerformanceBenchmarkPanel
