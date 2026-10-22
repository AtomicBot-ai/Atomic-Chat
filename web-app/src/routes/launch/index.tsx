import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { type as osType } from '@tauri-apps/plugin-os'
import { openUrl } from '@tauri-apps/plugin-opener'
import { toast } from 'sonner'
import {
  IconChevronDown,
  IconCopy,
  IconExternalLink,
  IconFolder,
  IconLoader2,
  IconTerminal2,
} from '@tabler/icons-react'
import { route } from '@/constants/routes'
import { queuedCapture } from '@/lib/telemetry-queue'
import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
import HeaderPage from '@/containers/HeaderPage'
import { Card } from '@/containers/Card'
import { AgentIcon } from '@/containers/AgentIcon'
import { detectIntegrationAgent } from '@/lib/integration-agent-detection'
import {
  agentConfiguredDescriptionKey,
  agentConnectHost,
  writeAgentConfig,
} from '@/lib/integration-agent-setup'
import { useServerSetup } from '@/hooks/useServerSetup'
import { LocalApiServerStatusRow } from '@/containers/LocalApiServerStatusRow'
import { startLocalApiServer } from '@/utils/localApiServerControl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useProxyConfig } from '@/hooks/useProxyConfig'
import { useAppState } from '@/hooks/useAppState'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useLaunchStore } from '@/stores/launch-store'
import { useLaunchSettings } from '@/stores/launch-settings-store'
import { cn } from '@/lib/utils'
import { createSafeUnlisten } from '@/lib/tauriEvent'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.launch.index as any)({
  component: LaunchPage,
})

// Only reveal the in-button spinner once an action has been running longer
// than this; near-instant config writes finish first and never flash it.
const SPINNER_DELAY_MS = 350

// The token that starts an agent in the terminal we open.
//
// Normally the bare binary name: short to read, and it resolves against the
// login-shell PATH that terminal inherits. When detection found the launcher
// *off* PATH — a user-set custom path, or the prefix install OpenClaw's desktop
// app creates under `~/.openclaw/bin` — the bare name resolves to nothing, so
// the absolute path is used instead, quoted for the shell that will run it.
function launcherCommand(detectBin: string, path?: string): string {
  if (!path) return detectBin
  // cmd.exe has no escape for `"` inside a quoted token; POSIX shells take the
  // close-escape-reopen dance. Neither appears in a real install path, but a
  // username can contain a quote.
  return osType() === 'windows'
    ? `"${path.replace(/"/g, '')}"`
    : `'${path.replace(/'/g, `'\\''`)}'`
}

// Snapshot the app proxy config (if enabled) into the payload the Rust
// `install_agent` / `open_agent_terminal` commands expect, so spawned installers
// and the launched agent can reach the network behind a region block. Returns
// undefined when no proxy is configured, so the commands omit proxy env.
function buildProxyPayload():
  | { url: string; username?: string; password?: string; no_proxy?: string }
  | undefined {
  const { proxyEnabled, proxyUrl, proxyUsername, proxyPassword, noProxy } =
    useProxyConfig.getState()
  if (!proxyEnabled || !proxyUrl.trim()) return undefined
  return {
    url: proxyUrl.trim(),
    username: proxyUsername.trim() || undefined,
    password: proxyPassword || undefined,
    no_proxy: noProxy.trim() || undefined,
  }
}

// Installs are indeterminate (npm / curl script) with no progress %, so the
// button cycles short status messages to make it clear work is ongoing.
const INSTALL_STEP_KEYS = [
  'launch:installSteps.installing',
  'launch:installSteps.downloading',
  'launch:installSteps.building',
  'launch:installSteps.settingUp',
] as const

function InstallingLabel() {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  useEffect(() => {
    const id = setInterval(
      () => setStep((s) => (s + 1) % INSTALL_STEP_KEYS.length),
      4000
    )
    return () => clearInterval(id)
  }, [])
  // Fixed, compact width so the label + spinner fit inside the same-size
  // (Run-width) button and it never jumps as the text changes.
  // `key={step}` remounts the node on each change so the browser repaints it
  // cleanly — without it the previous frame's text was left as a stale-paint
  // rectangle next to the spinning (`animate-spin`) icon's compositing layer.
  return (
    <span
      key={step}
      className="pointer-events-none inline-block w-[68px] select-none truncate text-center text-xs leading-none"
    >
      {t(INSTALL_STEP_KEYS[step])}
    </span>
  )
}

// Manual binary-path override editor. Local draft state so typing doesn't
// thrash the persisted store; only `onSave` commits (and re-triggers detect).
function CustomPathRow({
  value,
  onSave,
}: {
  value: string
  onSave: (path: string) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave(draft)
          }}
          placeholder={t(
            IS_WINDOWS
              ? 'launch:customPathPlaceholderWindows'
              : 'launch:customPathPlaceholder'
          )}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => onSave(draft)}
        >
          {t('launch:savePath')}
        </Button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t('launch:customPathHint')}
      </p>
    </div>
  )
}

function LaunchPage() {
  const { t } = useTranslation()
  const {
    serverHost,
    serverPort,
    apiPrefix,
    apiKey,
    defaultModelLocalApiServer,
  } = useLocalApiServer()
  const { serverStatus, setServerStatus } = useAppState()
  const serviceHub = useServiceHub()

  // Transient install / run state lives in a module-level store so it survives
  // navigating away from and back to this page mid-install (the Rust installer
  // keeps running; we must keep showing its progress on return).
  const installed = useLaunchStore((s) => s.installed)
  const viaWsl = useLaunchStore((s) => s.viaWsl)
  const customPaths = useLaunchSettings((s) => s.customPaths)
  const setCustomPath = useLaunchSettings((s) => s.setCustomPath)
  const busy = useLaunchStore((s) => s.busy)
  const setBusy = useLaunchStore((s) => s.setBusy)
  const spinning = useLaunchStore((s) => s.spinning)
  const setSpinning = useLaunchStore((s) => s.setSpinning)
  const phase = useLaunchStore((s) => s.phase)
  const setPhase = useLaunchStore((s) => s.setPhase)
  const logs = useLaunchStore((s) => s.logs)
  const setLogs = useLaunchStore((s) => s.setLogs)
  const openLog = useLaunchStore((s) => s.openLog)
  const setOpenLog = useLaunchStore((s) => s.setOpenLog)
  const [runningModels, setRunningModels] = useState<string[]>([])
  const [openPath, setOpenPath] = useState<Record<string, boolean>>({})
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({})
  const [editorBusy, setEditorBusy] = useState<Record<string, boolean>>({})

  const detect = useCallback(
    (agent: IntegrationAgent): Promise<boolean> =>
      detectIntegrationAgent(agent, customPaths[agent.id]),
    [customPaths]
  )

  const refreshRunningModels = useCallback(async () => {
    try {
      const active = (await serviceHub.models().getActiveModels()) || []
      setRunningModels(active)
    } catch {
      setRunningModels([])
    }
  }, [serviceHub])

  useEffect(() => {
    INTEGRATION_AGENTS.forEach((agent) => detect(agent))
  }, [detect])

  // First visit clears the sidebar "New" pill on Integrations.
  useEffect(() => {
    useGeneralSetting.getState().markIntegrationsBadgeSeen()
  }, [])

  useEffect(() => {
    refreshRunningModels()
  }, [refreshRunningModels, serverStatus])

  // Prefer a locally-running engine model; when none is running (e.g. the
  // user's current selection is a cloud provider like OpenRouter/OpenAI),
  // fall back to the "Current Model" shown in the Local API Server panel —
  // it is kept in sync with the globally selected model/provider (see
  // `syncModelSelection` in `switchModel.ts`) and is exactly what the proxy
  // at :1337 will actually route, so agents get configured against it too.
  const activeModel =
    runningModels[0] ?? defaultModelLocalApiServer?.model ?? null

  const ensureServerRunning = useCallback(async () => {
    if (serverStatus === 'running') return
    try {
      await startLocalApiServer()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('already running')) throw err
    }
    setServerStatus('running')
  }, [serverStatus, setServerStatus])

  // Install the agent's binary, streaming its installer log. Returns whether
  // the install succeeded. Does NOT manage the shared busy/spinner state —
  // `handleRun` owns that so install + configure read as one action.
  const installAgent = useCallback(
    async (agent: IntegrationAgent): Promise<boolean> => {
      setLogs((prev) => ({ ...prev, [agent.id]: [] }))
      setOpenLog((prev) => ({ ...prev, [agent.id]: true }))

      let detachInstallLog: (() => Promise<void>) | undefined
      try {
        detachInstallLog = createSafeUnlisten(
          await listen<string>(`agent_install_log:${agent.id}`, (event) => {
            setLogs((prev) => ({
              ...prev,
              [agent.id]: [...(prev[agent.id] ?? []), event.payload],
            }))
          })
        )
        await invoke('install_agent', {
          agentId: agent.id,
          proxy: buildProxyPayload(),
        })
        toast.success(t('launch:toast.installSuccess', { name: agent.name }), {
          description: t('launch:toast.installSuccessDesc', {
            name: agent.name,
          }),
        })
        await detect(agent)
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Surface a localized, actionable hint for network/DNS failures
        // (commonly a region block with no proxy); keep the raw detail otherwise.
        const isNetworkFailure =
          /dns|tunnel|proxy|os error 11001|wsahost_not_found|could not reach the network|resolve host|getaddrinfo|name resolution/i.test(
            msg
          )
        toast.error(t('launch:toast.installFailed', { name: agent.name }), {
          description: isNetworkFailure
            ? t('launch:toast.installFailedNetworkDesc')
            : msg,
        })
        return false
      } finally {
        await detachInstallLog?.()
      }
    },
    [detect, t, setLogs, setOpenLog]
  )

  // Write the agent's config so it points at the local server. Throws on
  // failure so the caller can surface a single error toast.
  const configureAgent = useCallback(
    async (agent: IntegrationAgent, model: string | null) => {
      if (serverStatus !== 'running') {
        toast.info(t('launch:toast.serverStarting'), {
          description: t('launch:toast.serverStartingDesc', {
            name: agent.name,
          }),
        })
        await ensureServerRunning()
      }

      await writeAgentConfig(agent, model, {
        serverHost,
        serverPort,
        apiPrefix,
        apiKey,
      })
      useServerSetup.getState().markAgentConfigured(agent.id)

      const configuredDescKey = agentConfiguredDescriptionKey(agent.id)
      toast.success(t('launch:toast.configured', { name: agent.name }), {
        description: t(configuredDescKey, { name: agent.name }),
        duration: 8000,
      })
    },
    [
      serverStatus,
      ensureServerRunning,
      serverHost,
      serverPort,
      apiPrefix,
      apiKey,
      t,
    ]
  )

  // Single entry point behind the unified button: install first if the agent
  // isn't present yet, then configure it to use the running model.
  const handleRun = useCallback(
    async (agent: IntegrationAgent) => {
      const model = activeModel
      if (agent.requiresModel && !model) {
        toast.error(t('launch:noRunningModelToast', { name: agent.name }))
        return
      }

      queuedCapture('agent_run', {
        agent_id: agent.id,
        agent_name: agent.name,
        agent_kind: agent.kind,
      })

      setBusy((prev) => ({ ...prev, [agent.id]: true }))
      const spinTimer = setTimeout(
        () => setSpinning((prev) => ({ ...prev, [agent.id]: true })),
        SPINNER_DELAY_MS
      )
      try {
        let present = installed[agent.id]
        if (present === undefined) present = await detect(agent)

        if (agent.installable && !present) {
          setPhase((prev) => ({ ...prev, [agent.id]: 'installing' }))
          const ok = await installAgent(agent)
          if (!ok) return
        }

        setPhase((prev) => ({ ...prev, [agent.id]: 'configuring' }))
        await configureAgent(agent, model)

        // Config is written; open a terminal running the agent so the user can
        // start immediately. A terminal failure must not fail the whole Run.
        try {
          // Zed is a desktop editor, not a terminal agent: its AI agent lives
          // in its own window. Launch the app directly (no terminal) — the
          // config we just wrote points its native Atomic Chat provider at the
          // local server, and the user drives the Agent Panel from there.
          if (agent.id === 'zed') {
            await invoke('launch_zed')
            return
          }
          // ZCode is a desktop app too, and it is never installed from here:
          // the provider file is written either way and read on its next start,
          // so a missing app is a pointer to the download, not a failure.
          if (agent.id === 'zcode') {
            const app = await invoke<{ installed: boolean; launched: boolean }>(
              'launch_zcode',
              { path: useLaunchStore.getState().binPath[agent.id] ?? null }
            )
            if (!app.installed) {
              toast.info(t('launch:toast.zcodeNotInstalled'), {
                description: t('launch:toast.zcodeNotInstalledDesc'),
                duration: 10000,
              })
            }
            return
          }
          // OpenClaw also ships a desktop app (macOS `OpenClaw.app`, Windows
          // Hub), and it reads the very config we just wrote — its Gateway owns
          // the file and hot-reloads it. So when the app is installed it *is*
          // the destination, and dropping the user into a terminal TUI would
          // land them in the wrong window.
          if (agent.id === 'openclaw') {
            const app = await invoke<{
              installed: boolean
              launched: boolean
            }>('launch_openclaw_app')
            if (app.launched) return
            if (app.installed) {
              // Windows Hub installs per-user with no documented path or AUMID
              // to launch it by, so hand the user the one instruction we can
              // give confidently instead of guessing at a shortcut.
              toast.info(t('launch:toast.openclawAppReady'), {
                description: t('launch:toast.openclawAppReadyDesc'),
                duration: 10000,
              })
              return
            }
          }
          // OpenClaw's bare `openclaw` entry is the Crestodian setup/repair
          // helper (deterministic commands), not a chat. `openclaw chat` runs
          // the embedded local agent runtime, so the user lands straight in a
          // conversation with the configured model (no gateway needed).
          // Goose's bare `goose` only prints help; `goose session` starts an
          // interactive chat. OpenHands reads our env overrides only when
          // launched with `--override-with-envs`. Everything else runs its
          // bare detect binary.
          let command: string
          // Off-PATH installs (custom path, or OpenClaw's app-managed prefix)
          // have to be spawned by absolute path; everything else keeps the bare
          // binary name.
          // Read through the store rather than a render-closure copy: this same
          // callback may have just run `detect`, whose result is not in the
          // closure it was invoked from.
          const launcher = launcherCommand(
            agent.detectBin,
            useLaunchStore.getState().binPath[agent.id]
          )
          if (agent.id === 'openclaw') {
            command = `${launcher} chat`
          } else if (agent.id === 'goose') {
            command = `${launcher} session`
          } else if (agent.id === 'openhands') {
            command = `${launcher} --override-with-envs`
          } else if (agent.id === 'dsh') {
            // DeepSeek Harness is a browser app, not a terminal chat: a bare
            // `dsh` has no profile to hand its arguments to and only prints the
            // launcher's own help. `dsh web` is the alias for `--profile web`,
            // which serves the UI on http://127.0.0.1:3080. The first run of
            // that profile initializes it from a shipped template, so the URL
            // can take a while to appear.
            command = `${launcher} web`
          } else if (agent.id === 'muse') {
            // Muse Code has no writable endpoint configuration: the provider,
            // base URL and model are flags on every invocation, and META_API_KEY
            // only has to be non-empty for its provider check -- the request
            // itself goes to whatever --base-url points at. `apiUrl` already
            // carries the /v1 prefix (endpointWithPrefix), which is the root
            // Muse appends `/responses` to.
            const apiUrl = `http://${agentConnectHost(serverHost)}:${serverPort}${apiPrefix}`
            const key = apiKey || 'atomic'
            if (osType() === 'windows') {
              const modelArg = model ? ` --model ${model}` : ''
              command = `set META_API_KEY=${key}&& ${launcher} --provider meta --base-url ${apiUrl}${modelArg}`
            } else {
              const modelArg = model ? ` --model '${model}'` : ''
              command = `META_API_KEY='${key}' ${launcher} --provider meta --base-url '${apiUrl}'${modelArg}`
            }
          } else if (agent.id === 'poolside') {
            const apiUrl = `http://${agentConnectHost(serverHost)}:${serverPort}${apiPrefix}`
            const standaloneBase = apiUrl.replace(/\/v1\/?$/, '')
            const key = apiKey || 'atomic'
            const modelId = model ?? ''
            if (osType() === 'windows') {
              command = `set POOLSIDE_STANDALONE_BASE_URL=${standaloneBase}&& set POOLSIDE_API_KEY=${key}&& set POOLSIDE_STANDALONE_MODEL=${modelId}&& ${launcher}`
            } else {
              command = `POOLSIDE_STANDALONE_BASE_URL='${standaloneBase}' POOLSIDE_API_KEY='${key}' POOLSIDE_STANDALONE_MODEL='${modelId}' ${launcher}`
            }
          } else {
            command = launcher
          }
          await invoke('open_agent_terminal', {
            command,
            proxy: buildProxyPayload(),
          })
        } catch (termErr) {
          const tmsg =
            termErr instanceof Error ? termErr.message : String(termErr)
          toast.warning(
            t('launch:toast.terminalFailed', { name: agent.name }),
            {
              description: tmsg,
            }
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(t('launch:toast.configureFailed', { name: agent.name }), {
          description: msg,
        })
      } finally {
        clearTimeout(spinTimer)
        setBusy((prev) => ({ ...prev, [agent.id]: false }))
        setSpinning((prev) => ({ ...prev, [agent.id]: false }))
        setPhase((prev) => ({ ...prev, [agent.id]: undefined }))
      }
    },
    [
      activeModel,
      installed,
      detect,
      installAgent,
      configureAgent,
      t,
      setBusy,
      setSpinning,
      setPhase,
      serverHost,
      serverPort,
      apiPrefix,
      apiKey,
    ]
  )

  // Connection details an editor's BYOK / "OpenAI-compatible provider" UI
  // needs. Editors append their own `/chat/completions` path, so the Base URL
  // carries the `/v1` prefix; the key is whatever the server requires (a
  // non-empty placeholder when auth is off, since most editors demand one).
  const editorConnection = useCallback(() => {
    return {
      baseUrl: `http://${agentConnectHost(serverHost)}:${serverPort}${apiPrefix}`,
      apiKey: apiKey || 'atomic',
      model: activeModel,
    }
  }, [serverHost, serverPort, apiPrefix, apiKey, activeModel])

  // Copy the Base URL / API key / model block to the clipboard so the user can
  // paste it into the editor's provider settings (these editors keep the
  // provider in secret/IDE storage with no writable config file).
  const handleCopySettings = useCallback(
    async (agent: IntegrationAgent) => {
      const { baseUrl, apiKey: key, model } = editorConnection()
      const lines = [
        `Base URL: ${baseUrl}`,
        `API key: ${key}`,
        `Model: ${model ?? '(load a model in a chat first)'}`,
      ]
      try {
        await navigator.clipboard.writeText(lines.join('\n'))
        toast.success(t('launch:toast.settingsCopied'), {
          description: t('launch:toast.settingsCopiedDesc', {
            name: agent.name,
          }),
        })
      } catch {
        toast.error(t('launch:toast.copyFailed'))
      }
    },
    [editorConnection, t]
  )

  // Make sure the local server is up, copy the connection settings, then open
  // the editor. The user finishes setup inside the editor's own UI.
  const handleLaunchEditor = useCallback(
    async (agent: IntegrationAgent) => {
      const launchId = agent.editor?.launchId
      if (!launchId) return

      queuedCapture('editor_launch', {
        editor_id: agent.id,
        editor_name: agent.name,
      })

      setEditorBusy((prev) => ({ ...prev, [agent.id]: true }))
      try {
        await ensureServerRunning()
        await handleCopySettings(agent)
        await invoke('launch_editor', { editorId: launchId })
        toast.success(t('launch:toast.editorLaunched', { name: agent.name }), {
          description: t('launch:toast.editorLaunchedDesc', {
            name: agent.name,
          }),
          duration: 8000,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(
          t('launch:toast.editorLaunchFailed', { name: agent.name }),
          {
            description: msg,
          }
        )
      } finally {
        setEditorBusy((prev) => ({ ...prev, [agent.id]: false }))
      }
    },
    [ensureServerRunning, handleCopySettings, t]
  )

  const coding = INTEGRATION_AGENTS.filter((a) => a.kind === 'coding')
  const assistants = INTEGRATION_AGENTS.filter((a) => a.kind === 'assistant')
  const editors = INTEGRATION_AGENTS.filter((a) => a.kind === 'editor')

  const renderEditor = (agent: IntegrationAgent) => {
    const isInstalled = installed[agent.id]
    const isBusy = editorBusy[agent.id]
    const steps = agent.editor?.steps ?? []

    return (
      <Card key={agent.id} id={agent.id} className="bg-card rounded-lg">
        <div className="flex items-center gap-3">
          <AgentIcon agent={agent} />
          <h2 className="font-studio truncate text-base font-medium text-foreground">
            {agent.name}
          </h2>
          {isInstalled !== undefined && (
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                isInstalled
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {isInstalled ? t('launch:installed') : t('launch:notInstalled')}
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openUrl(agent.docsUrl)}
            >
              <IconExternalLink size={14} className="text-muted-foreground" />
              {t('launch:docs')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={() => handleCopySettings(agent)}
            >
              <IconCopy size={14} />
              {t('launch:copySettings')}
            </Button>
            <Button
              size="sm"
              className="w-[112px] transform-gpu justify-center gap-1.5 select-none"
              onClick={() => handleLaunchEditor(agent)}
              disabled={isBusy}
            >
              {isBusy && <IconLoader2 size={14} className="animate-spin" />}
              {t('launch:enable')}
            </Button>
          </div>
        </div>
        <p className="mt-2 text-sm leading-normal text-muted-foreground">
          {agent.description}
        </p>

        {serverStatus !== 'running' && (
          <p className="mt-2 text-[11px] leading-relaxed text-amber-600">
            {t('launch:serverNotRunningHint', { name: agent.name })}
          </p>
        )}

        <div className="mt-3">
          <button
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() =>
              setOpenSteps((prev) => ({
                ...prev,
                [agent.id]: !prev[agent.id],
              }))
            }
          >
            <IconTerminal2 size={14} />
            {t('launch:manualSetup')}
            <IconChevronDown
              size={14}
              className={cn(
                'transition-transform',
                openSteps[agent.id] && 'rotate-180'
              )}
            />
          </button>
          {openSteps[agent.id] && (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </div>
      </Card>
    )
  }

  const renderAgent = (agent: IntegrationAgent) => {
    const isInstalled = installed[agent.id]
    const isViaWsl = viaWsl[agent.id]
    const isBusy = busy[agent.id]
    const isSpinning = spinning[agent.id]
    const runPhase = phase[agent.id]
    const agentLogs = logs[agent.id] ?? []

    return (
      <Card key={agent.id} id={agent.id} className="bg-card rounded-lg">
        <div className="flex items-center gap-3">
          <AgentIcon agent={agent} />
          <h2 className="font-studio truncate text-base font-medium text-foreground">
            {agent.name}
          </h2>
          {isInstalled !== undefined && (
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                isInstalled
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {isInstalled
                ? isViaWsl
                  ? t('launch:installedViaWsl')
                  : t('launch:installed')
                : t('launch:notInstalled')}
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openUrl(agent.docsUrl)}
            >
              <IconExternalLink size={14} className="text-muted-foreground" />
              {t('launch:docs')}
            </Button>
            {agent.configurable && (
              <Button
                size="sm"
                className="w-[112px] transform-gpu justify-center gap-1.5 select-none"
                onClick={() => handleRun(agent)}
                disabled={isBusy}
              >
                {runPhase === 'installing' ? (
                  <>
                    <IconLoader2
                      size={14}
                      className="pointer-events-none animate-spin"
                    />
                    <InstallingLabel />
                  </>
                ) : (
                  <>
                    {runPhase === 'configuring' && isSpinning && (
                      <IconLoader2 size={14} className="animate-spin" />
                    )}
                    {t('launch:enable')}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 text-sm leading-normal text-muted-foreground">
          {agent.description}
        </p>

        <div className="mt-3">
          <button
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() =>
              setOpenPath((prev) => ({
                ...prev,
                [agent.id]: !prev[agent.id],
              }))
            }
          >
            <IconFolder size={14} />
            {customPaths[agent.id]
              ? t('launch:customPathSet')
              : t('launch:setCustomPath')}
            <IconChevronDown
              size={14}
              className={cn(
                'transition-transform',
                openPath[agent.id] && 'rotate-180'
              )}
            />
          </button>
          {openPath[agent.id] && (
            <CustomPathRow
              value={customPaths[agent.id] ?? ''}
              onSave={(path) => setCustomPath(agent.id, path)}
            />
          )}
        </div>

        {agentLogs.length > 0 && (
          <div className="mt-3">
            <button
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                setOpenLog((prev) => ({
                  ...prev,
                  [agent.id]: !prev[agent.id],
                }))
              }
            >
              <IconTerminal2 size={14} />
              {t('launch:installLog')}
              <IconChevronDown
                size={14}
                className={cn(
                  'transition-transform',
                  openLog[agent.id] && 'rotate-180'
                )}
              />
            </button>
            {openLog[agent.id] && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-secondary/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
                {agentLogs.join('\n')}
              </pre>
            )}
          </div>
        )}
      </Card>
    )
  }

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">
            {t('launch:title')}
          </span>
        </div>
      </HeaderPage>
      <div className="h-[calc(100%-60px)] overflow-y-auto p-4 pt-0">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <section className="flex flex-col gap-3">
            <div>
              <h1 className="font-studio text-lg font-medium text-foreground">
                {t('launch:serverSection')}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t('launch:serverSectionDesc')}
              </p>
            </div>
            <LocalApiServerStatusRow />
          </section>

          {assistants.length > 0 && (
            <section className="flex flex-col gap-3">
              <div>
                <h1 className="font-studio text-lg font-medium text-foreground">
                  {t('launch:assistants')}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {t('launch:assistantsDesc')}
                </p>
              </div>
              {assistants.map(renderAgent)}
            </section>
          )}

          <section className="flex flex-col gap-3">
            <div>
              <h1 className="font-studio text-lg font-medium text-foreground">
                {t('launch:codingAgents')}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t('launch:codingAgentsDesc')}
              </p>
            </div>
            {coding.map(renderAgent)}
          </section>

          {editors.length > 0 && (
            <section className="flex flex-col gap-3">
              <div>
                <h1 className="font-studio text-lg font-medium text-foreground">
                  {t('launch:editors')}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {t('launch:editorsDesc')}
                </p>
              </div>
              {editors.map(renderEditor)}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
