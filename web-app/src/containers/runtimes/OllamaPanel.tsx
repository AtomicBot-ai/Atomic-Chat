/**
 * Ollama, run and configured from inside Radium: install, start/stop, take
 * over an Ollama started outside Radium, models, settings and logs in one
 * panel. Sections expand in place so the page stays short until more is
 * needed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  IconChevronDown,
  IconDownload,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  collapsiblePanelAnimation,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { connectRuntime } from '@/lib/connect-runtime'
import { cn } from '@/lib/utils'
import {
  changedKeys,
  coerceSetting,
  describePull,
  formatBytes,
  ollama,
  ollamaSettingFields,
  type ModelList,
  type OllamaSettings,
  type OllamaStatus,
  type PullProgress,
  type SettingField,
} from '@/services/ollama'

const STATUS_POLL_MS = 5000
const LOG_POLL_MS = 2000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function taskId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

type Phase = 'running' | 'external' | 'stopped' | 'not-installed'

function phaseOf(status: OllamaStatus | null): Phase {
  if (!status) return 'stopped'
  if (status.running) return 'running'
  if (status.external) return 'external'
  if (!status.binary) return 'not-installed'
  return 'stopped'
}

const PHASE_LABEL: Record<Phase, string> = {
  'running': 'Running in Radium',
  'external': 'Running outside Radium',
  'stopped': 'Stopped',
  'not-installed': 'Not installed',
}

function StatusDot({ phase }: { phase: Phase }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 rounded-full',
        phase === 'running' && 'bg-emerald-500',
        phase === 'external' && 'bg-amber-500',
        phase === 'stopped' && 'bg-muted-foreground/50',
        phase === 'not-installed' && 'border border-muted-foreground/50'
      )}
    />
  )
}

/** One expandable section: a header row that opens its body in place. */
function Section({
  title,
  summary,
  defaultOpen,
  children,
}: {
  title: string
  summary?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-t border-border/40"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-left">
        <IconChevronDown
          size={14}
          className={cn('transition-transform', !open && '-rotate-90')}
        />
        <span className="font-medium text-foreground">{title}</span>
        {summary && (
          <span className="ml-auto text-xs text-muted-foreground">
            {summary}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={collapsiblePanelAnimation}>
        <div className="pb-3 pl-6">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SettingRow({
  field,
  value,
  onChange,
}: {
  field: SettingField
  value: OllamaSettings[keyof OllamaSettings]
  onChange: (value: string | number | boolean) => void
}) {
  return (
    <div
      data-setting={field.key}
      className="flex items-start justify-between gap-6 border-b border-border/30 py-2.5 last:border-none"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{field.title}</div>
        <p className="text-xs text-muted-foreground">{field.description}</p>
      </div>
      <div
        className={cn(
          'shrink-0',
          field.controllerType === 'textarea' ? 'w-80' : 'w-56'
        )}
      >
        <DynamicControllerSetting
          controllerType={field.controllerType}
          controllerProps={{
            value: value as string | number | boolean,
            placeholder: field.placeholder,
            type: field.inputType,
            options: field.options,
            rows: 4,
          }}
          onChange={onChange}
        />
      </div>
    </div>
  )
}

export function OllamaPanel() {
  const serviceHub = useServiceHub()
  const { addProvider, updateProvider } = useModelProvider()
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [install, setInstall] = useState<{
    id: string
    received: number
    total: number
  } | null>(null)
  const [draft, setDraft] = useState<OllamaSettings | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [gpus, setGpus] = useState<Array<{ uuid: string; name: string }>>([])
  const [models, setModels] = useState<ModelList | null>(null)
  const [pullName, setPullName] = useState('')
  const [pull, setPull] = useState<{
    id: string
    model: string
    progress: PullProgress | null
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [takeOverOpen, setTakeOverOpen] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [logsOpen, setLogsOpen] = useState(false)
  const logEnd = useRef<HTMLDivElement | null>(null)

  const phase = phaseOf(status)
  const reachableUrl =
    phase === 'running'
      ? status?.baseUrl
      : phase === 'external'
        ? status?.external?.baseUrl
        : null

  const refreshStatus = useCallback(async () => {
    try {
      const next = await ollama.status()
      setStatus(next)
      setDraft((current) => current ?? next.settings)
    } catch (error) {
      console.warn('[ollama] status failed', error)
    }
  }, [])

  const refreshModels = useCallback(async () => {
    if (!reachableUrl) {
      setModels(null)
      return
    }
    try {
      setModels(await ollama.models(reachableUrl))
    } catch (error) {
      console.warn('[ollama] model list failed', error)
    }
  }, [reachableUrl])

  useEffect(() => {
    void refreshStatus()
    const timer = setInterval(refreshStatus, STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [refreshStatus])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  useEffect(() => {
    serviceHub
      .hardware()
      .getHardwareInfo()
      .then((info) =>
        setGpus(
          (info?.gpus ?? [])
            .filter(
              (gpu) =>
                gpu.uuid &&
                gpu.vendor?.toString().toLowerCase().includes('nvidia')
            )
            .map((gpu) => ({ uuid: gpu.uuid, name: gpu.name }))
        )
      )
      .catch(() => setGpus([]))
  }, [serviceHub])

  useEffect(() => {
    if (!logsOpen) return
    const read = () =>
      ollama
        .logs()
        .then(setLogs)
        .catch(() => undefined)
    void read()
    const timer = setInterval(read, LOG_POLL_MS)
    return () => clearInterval(timer)
  }, [logsOpen, status?.running])

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' })
  }, [logs])

  /** Makes the models usable in chat as soon as Ollama is up. */
  const connect = useCallback(
    async (baseUrl: string) => {
      try {
        await connectRuntime(
          { kind: 'provider', providerId: 'ollama', baseUrl: `${baseUrl}/v1` },
          [],
          {
            providers: useModelProvider.getState().providers,
            addProvider,
            updateProvider,
            getProviderByName: (name) =>
              useModelProvider.getState().getProviderByName(name),
            serviceHub,
          }
        )
      } catch (error) {
        // No models yet is normal on a fresh install; the chat picker fills
        // in once one is downloaded.
        console.info('[ollama] not connected yet:', errorText(error))
      }
    },
    [addProvider, updateProvider, serviceHub]
  )

  const run = useCallback(
    async (
      label: string,
      action: () => Promise<OllamaStatus>,
      success?: string
    ) => {
      setBusy(label)
      try {
        const next = await action()
        setStatus(next)
        if (next.running) await connect(next.baseUrl)
        if (success) toast.success(success)
      } catch (error) {
        toast.error(`Ollama: ${label} failed`, {
          description: errorText(error),
        })
      } finally {
        setBusy(null)
        void refreshStatus()
      }
    },
    [connect, refreshStatus]
  )

  const startInstall = async () => {
    const id = taskId('ollama-install')
    setInstall({ id, received: 0, total: status?.installBytes ?? 0 })
    try {
      await ollama.install(id, (received, total) =>
        setInstall({ id, received, total })
      )
      toast.success(`Ollama ${status?.installVersion} installed`)
      await run('start', ollama.start, 'Ollama is running')
    } catch (error) {
      toast.error('Ollama could not be installed', {
        description: errorText(error),
      })
    } finally {
      setInstall(null)
      void refreshStatus()
    }
  }

  const fields = useMemo(() => ollamaSettingFields(gpus), [gpus])
  const dirty = status && draft ? changedKeys(status.settings, draft) : []
  const needsRestart =
    phase === 'running' && dirty.some((key) => key !== 'autoStart')

  const saveSettings = async (restart: boolean) => {
    if (!draft) return
    setBusy('save')
    try {
      const saved = await ollama.saveSettings(draft)
      setDraft(saved.settings)
      if (restart && saved.needsRestart) {
        await run(
          'restart',
          ollama.restart,
          'Settings applied; Ollama restarted'
        )
      } else {
        toast.success('Ollama settings saved')
        void refreshStatus()
      }
    } catch (error) {
      toast.error('Settings not saved', { description: errorText(error) })
    } finally {
      setBusy(null)
    }
  }

  const startPull = async () => {
    const model = pullName.trim()
    if (!model || !reachableUrl) return
    const id = taskId('ollama-pull')
    setPull({ id, model, progress: null })
    try {
      await ollama.pull(reachableUrl, model, id, (progress) =>
        setPull({ id, model, progress })
      )
      toast.success(`${model} downloaded`)
      setPullName('')
      await refreshModels()
      if (status?.running) await connect(status.baseUrl)
    } catch (error) {
      toast.error(`${model} did not download`, {
        description: errorText(error),
      })
    } finally {
      setPull(null)
    }
  }

  const modelAction = async (label: string, action: () => Promise<void>) => {
    setBusy(label)
    try {
      await action()
      await refreshModels()
    } catch (error) {
      toast.error(`Ollama: ${label} failed`, { description: errorText(error) })
    } finally {
      setBusy(null)
    }
  }

  const loadedNames = new Set(models?.loaded.map((model) => model.name) ?? [])
  const visibleFields = fields.filter(
    (field) => showAdvanced || !field.advanced
  )

  return (
    <div
      className="rounded-lg border border-border/60 bg-secondary/20 px-4 pt-3"
      data-testid="ollama-panel"
    >
      {/* Header: identity, state and the one action that matters now. */}
      <div className="flex flex-wrap items-center gap-3 pb-3">
        <img
          src="/images/model-provider/ollama.svg"
          alt=""
          className="size-8 rounded-full bg-white p-0.5"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground text-base">
              Ollama
            </span>
            <StatusDot phase={phase} />
            <span
              className="text-xs text-muted-foreground"
              data-testid="ollama-phase"
            >
              {PHASE_LABEL[phase]}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {phase === 'running' &&
              `v${status?.version ?? '?'} · ${status?.baseUrl}`}
            {phase === 'external' &&
              `v${status?.external?.version ?? '?'} · ${status?.external?.baseUrl}`}
            {phase === 'stopped' &&
              status?.binary &&
              (status.binary.source === 'radium'
                ? 'Radium’s copy'
                : 'Your installed Ollama')}
            {phase === 'not-installed' &&
              (status?.canInstall
                ? `Radium can install Ollama ${status.installVersion} (${formatBytes(status.installBytes)})`
                : 'Install Ollama from ollama.com and Radium will find it')}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {phase === 'running' && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => run('restart', ollama.restart)}
              >
                <IconRefresh /> Restart
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => run('stop', ollama.stop)}
              >
                <IconPlayerStop /> Stop
              </Button>
            </>
          )}
          {phase === 'stopped' && (
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() => run('start', ollama.start, 'Ollama is running')}
            >
              <IconPlayerPlay /> {busy === 'start' ? 'Starting…' : 'Start'}
            </Button>
          )}
          {phase === 'external' && (
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() => setTakeOverOpen(true)}
            >
              Run it in Radium
            </Button>
          )}
          {phase === 'not-installed' && status?.canInstall && !install && (
            <Button size="sm" onClick={startInstall}>
              <IconDownload /> Install
            </Button>
          )}
          {phase === 'not-installed' && status && !status.canInstall && (
            <Button asChild size="sm" variant="outline">
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noreferrer"
              >
                Get Ollama
              </a>
            </Button>
          )}
        </div>
      </div>

      {install && (
        <div className="flex items-center gap-3 pb-3">
          <Progress
            className="h-1.5 flex-1"
            value={
              install.total
                ? (install.received / install.total) * 100
                : undefined
            }
          />
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatBytes(install.received)} / {formatBytes(install.total)}
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => ollama.cancelInstall(install.id)}
          >
            Cancel
          </Button>
        </div>
      )}

      {phase === 'external' && (
        <p className="pb-3 text-sm text-muted-foreground">
          This Ollama was started outside Radium, so its settings can only be
          changed where it was started. Its models are listed below. Choose{' '}
          <em>Run it in Radium</em> to manage everything here.
        </p>
      )}

      <Section
        title="Models"
        defaultOpen
        summary={
          models
            ? `${models.installed.length} installed · ${models.loaded.length} in memory`
            : reachableUrl
              ? 'Loading…'
              : 'Start Ollama to see models'
        }
      >
        {reachableUrl ? (
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Input
                value={pullName}
                placeholder="Model to download, e.g. qwen3:8b or hf.co/user/repo:Q4_K_M"
                aria-label="Model to download"
                onChange={(event) => setPullName(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && startPull()}
                disabled={!!pull}
              />
              <Button
                size="sm"
                onClick={startPull}
                disabled={!pullName.trim() || !!pull}
              >
                <IconDownload /> Download
              </Button>
              <Button asChild size="sm" variant="ghost">
                <a
                  href="https://ollama.com/library"
                  target="_blank"
                  rel="noreferrer"
                >
                  Browse
                </a>
              </Button>
            </div>
            {pull && (
              <div
                className="flex items-center gap-3"
                data-testid="ollama-pull"
              >
                <span className="text-xs text-foreground">{pull.model}</span>
                <Progress
                  className="h-1.5 flex-1"
                  value={
                    pull.progress
                      ? (describePull(pull.progress).percent ?? undefined)
                      : undefined
                  }
                />
                <span className="w-44 truncate text-xs text-muted-foreground">
                  {pull.progress
                    ? describePull(pull.progress).label
                    : 'starting'}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => ollama.cancelPull(pull.id)}
                >
                  Cancel
                </Button>
              </div>
            )}
            {models && models.installed.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No models yet. Download one above.
              </p>
            )}
            <ul className="flex flex-col" data-testid="ollama-models">
              {models?.installed.map((model) => {
                const loaded = models.loaded.find(
                  (entry) => entry.name === model.name
                )
                return (
                  <li
                    key={model.name}
                    className="flex items-center gap-3 border-b border-border/30 py-2 last:border-none"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {model.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[
                          model.parameterSize,
                          model.quantization,
                          formatBytes(model.sizeBytes),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        {loaded &&
                          ` · in memory, ${formatBytes(loaded.vramBytes)} on GPU`}
                      </div>
                    </div>
                    {loadedNames.has(model.name) ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          modelAction('unload', () =>
                            ollama.unloadModel(reachableUrl, model.name)
                          )
                        }
                      >
                        Unload
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          modelAction('load', () =>
                            ollama.loadModel(reachableUrl, model.name)
                          )
                        }
                      >
                        {busy === 'load' ? 'Loading…' : 'Load'}
                      </Button>
                    )}
                    {confirmDelete === model.name ? (
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={() => {
                          setConfirmDelete(null)
                          void modelAction('delete', () =>
                            ollama.deleteModel(reachableUrl, model.name)
                          )
                        }}
                      >
                        Delete {formatBytes(model.sizeBytes)}?
                      </Button>
                    ) : (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Delete ${model.name}`}
                        onClick={() => setConfirmDelete(model.name)}
                      >
                        <IconTrash />
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {phase === 'not-installed'
              ? 'Install Ollama first.'
              : 'Start Ollama to manage its models.'}
          </p>
        )}
      </Section>

      <Section
        title="Settings"
        defaultOpen={phase !== 'external'}
        summary={dirty.length > 0 ? `${dirty.length} unsaved` : undefined}
      >
        {draft && (
          <div className="flex flex-col">
            {phase === 'external' && (
              <p className="pb-2 text-xs text-amber-700 dark:text-amber-400">
                These settings apply once Ollama runs in Radium.
              </p>
            )}
            {visibleFields.map((field) => (
              <SettingRow
                key={field.key}
                field={field}
                value={draft[field.key]}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    [field.key]: coerceSetting(field, value),
                  } as OllamaSettings)
                }
              />
            ))}
            <ModelsFolderHint draft={draft} status={status} />
            <div className="flex items-center gap-2 pt-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced
                  ? 'Hide advanced'
                  : `Show advanced (${fields.filter((f) => f.advanced).length})`}
              </Button>
              <span className="ml-auto" />
              {dirty.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => status && setDraft(status.settings)}
                >
                  Discard
                </Button>
              )}
              <Button
                size="sm"
                disabled={dirty.length === 0 || !!busy}
                onClick={() => saveSettings(needsRestart)}
              >
                {needsRestart ? 'Save and restart' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Collapsible
        open={logsOpen}
        onOpenChange={setLogsOpen}
        className="border-t border-border/40"
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-left">
          <IconChevronDown
            size={14}
            className={cn('transition-transform', !logsOpen && '-rotate-90')}
          />
          <span className="font-medium text-foreground">Logs</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {phase === 'running' ? 'Live' : 'From the last run'}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className={collapsiblePanelAnimation}>
          <div className="mb-3 ml-6 max-h-64 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {logs.length === 0
              ? 'Nothing logged yet.'
              : logs.map((line, index) => <div key={index}>{line}</div>)}
            <div ref={logEnd} />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Dialog open={takeOverOpen} onOpenChange={setTakeOverOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run Ollama in Radium?</DialogTitle>
            <DialogDescription>
              Radium will stop the Ollama that is running now
              {status?.external?.processes.some((p) =>
                p.name.toLowerCase().includes('app')
              )
                ? ', including its tray app,'
                : ''}{' '}
              and start it again with the settings on this page. Your downloaded
              models stay where they are and nothing is downloaded again.
              Anything using Ollama will pause for a few seconds while it
              restarts.
            </DialogDescription>
          </DialogHeader>
          {status?.external?.processes.length ? (
            <ul className="text-xs text-muted-foreground">
              {status.external.processes.map((process) => (
                <li key={process.pid}>
                  {process.name} (pid {process.pid})
                </li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTakeOverOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!!busy}
              onClick={async () => {
                setTakeOverOpen(false)
                await run(
                  'take over',
                  ollama.takeOver,
                  'Ollama now runs in Radium'
                )
              }}
            >
              Run it in Radium
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Where models live when the folder setting is left empty. */
function ModelsFolderHint({
  draft,
  status,
}: {
  draft: OllamaSettings
  status: OllamaStatus | null
}) {
  if (draft.modelsDir.trim() || !status?.defaultModelsDir) return null
  return (
    <p className="pt-2 text-xs text-muted-foreground">
      Models are kept in{' '}
      <span className="font-mono">{status.defaultModelsDir}</span>.
    </p>
  )
}
