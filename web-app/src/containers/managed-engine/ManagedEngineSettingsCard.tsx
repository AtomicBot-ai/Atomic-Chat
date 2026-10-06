import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { DropdownControl } from '@/containers/dynamicControllerSetting/DropdownControl'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { providerKey, type ManagedEngine } from '@/lib/managed-engines'
import { formatBytes } from '@/lib/utils'
import type { GpuFacts, ManagedError } from '@/services/managed-environment/types'
import {
  selectEnvironment,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * A managed engine's settings the generic list cannot render well (spec `tensorrt-llm-desktop`,
 * "Настройки, логи и удаление"): the card, chosen from the GPUs the core found rather than typed
 * as a UUID, the output limit checked against the context, and each model's container log. The
 * engine's other settings (context length, output limit, KV-cache, load timeout) stay in the generic
 * list, from the extension's `settings.json` (the core's schema). Changes apply from the next load.
 */

/** `GET /models/:provider/:id/logs`. */
type ModelLogs =
  | { model_id: string; source: 'session'; generation: string; log_tail: string }
  | {
      model_id: string
      source: 'last-attempt'
      generation: string
      log_tail: string
      error: ManagedError | null
      at: number
    }
  | { model_id: string; source: null; log_tail: '' }

const NO_GPUS: GpuFacts[] = []

const valueOf = (settings: ProviderSetting[], key: string): unknown =>
  (settings.find((s) => s.key === key)?.controller_props as { value?: unknown } | undefined)?.value

function gpuLabel(gpu: GpuFacts): string {
  const memory =
    gpu.free_vram_bytes !== null && gpu.total_vram_bytes !== null
      ? ` · ${formatBytes(gpu.free_vram_bytes)} / ${formatBytes(gpu.total_vram_bytes)}`
      : ''
  return `${gpu.name} (${gpu.compute_capability})${memory}`
}

export function ManagedEngineSettingsCard({
  engine,
  settings,
  models,
  onChange,
}: {
  engine: ManagedEngine
  settings: ProviderSetting[]
  /** Downloaded model ids, whose logs can be read. */
  models: string[]
  onChange: (key: string, value: unknown) => void
}) {
  const { t } = useTranslation()
  const k = providerKey(engine)
  const gpus = useManagedEnvironmentStore((state) => selectEnvironment(state)?.gpus ?? NO_GPUS)
  const gpuId = String(valueOf(settings, 'gpu_id') ?? '')
  const context = Number(valueOf(settings, 'context_length'))
  const output = Number(valueOf(settings, 'max_output_tokens'))
  const [logs, setLogs] = useState<{ model: string; logs?: ModelLogs; error?: string } | null>(null)
  // One entry point for every model's log: the model is picked, not given a button of its own.
  const [picked, setPicked] = useState<string | null>(null)
  const logModel = picked !== null && models.includes(picked) ? picked : (models[0] ?? null)

  const gpuGone = gpuId !== '' && !gpus.some((gpu) => gpu.gpu_id === gpuId)

  const showLogs = async (model: string) => {
    setLogs({ model })
    try {
      const answer = await invoke<ModelLogs>('atomic_core_call', {
        method: 'GET',
        path: `/models/${engine.id}/${model}/logs`,
        body: null,
      })
      setLogs({ model, logs: answer })
    } catch (error) {
      setLogs({ model, error: String((error as { message?: unknown })?.message ?? error) })
    }
  }

  return (
    <Card
      header={
        <h1 className="text-foreground font-medium text-base mb-4">
          {t(k('settings.title'))}
        </h1>
      }
    >
      <CardItem
        title={t(k('settings.gpu'))}
        description={
          gpuGone
            ? t(k('settings.gpuMissing'), { gpu: gpuId })
            : t(k('settings.gpuDescription'))
        }
        // Bounded, so a long card name truncates inside the menu instead of widening the row.
        classNameWrapperAction="w-80 max-w-[50%]"
        actions={
          // The app's own menu, not a native <select>: WebKitGTK draws a select's list with the
          // system theme, so in the app's dark theme it came up light (F-11).
          <DropdownControl
            value={gpuId}
            options={[
              { value: '', name: t(k('settings.gpuDefault')) },
              ...gpus.map((gpu) => ({ value: gpu.gpu_id, name: gpuLabel(gpu) })),
              ...(gpuGone ? [{ value: gpuId, name: gpuId }] : []),
            ]}
            onChange={(value) => onChange('gpu_id', String(value))}
          />
        }
      />

      {Number.isFinite(context) && Number.isFinite(output) && output >= context && (
        <p className="mt-2 text-sm text-destructive">
          {t(k('settings.outputTooLong'), { output, context })}
        </p>
      )}

      {logModel !== null && (
        <CardItem
          title={t(k('settings.logs'))}
          description={t(k('settings.logsDescription'))}
          // Under the title, across the card: a model id is long (`deepseek-ai/deepseek-coder-…`), and
          // beside the title it pushed the button out of the card.
          column
          classNameWrapperAction="mt-3"
          actions={
            <div className="flex w-full min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                {models.length > 1 ? (
                  <DropdownControl
                    value={logModel}
                    options={models.map((model) => ({ value: model, name: model }))}
                    onChange={(value) => setPicked(String(value))}
                  />
                ) : (
                  <p className="truncate text-sm text-foreground">{logModel}</p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void showLogs(logModel)}
              >
                {t(k('settings.viewLogs'))}
              </Button>
            </div>
          }
        />
      )}

      {logs && (
        <div className="mt-3 flex min-w-0 flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t(k('settings.logOf'), { model: logs.model })}
          </p>
          {logs.logs?.source === 'last-attempt' && logs.logs.error && (
            <p className="text-sm text-destructive break-words">{logs.logs.error.message}</p>
          )}
          {logs.error && <p className="text-sm text-destructive break-words">{logs.error}</p>}
          {logs.logs && (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-3 text-xs text-foreground whitespace-pre-wrap break-words">
              {logs.logs.log_tail || t(k('settings.noLogs'))}
            </pre>
          )}
        </div>
      )}
    </Card>
  )
}
