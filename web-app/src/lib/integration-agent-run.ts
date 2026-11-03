import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { type as osType } from '@tauri-apps/plugin-os'
import { toast } from 'sonner'

import type { IntegrationAgent } from '@/constants/integrations'
import { useProxyConfig } from '@/hooks/useProxyConfig'
import {
  agentConnectHost,
  type AgentServerSettings,
} from '@/lib/integration-agent-setup'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import { useLaunchStore } from '@/stores/launch-store'
import { servedContextLength } from '@/utils/servedModel'

type Translate = (key: string, options?: Record<string, unknown>) => string

// The token that starts an agent in the terminal we open.
//
// Normally the bare binary name: short to read, and it resolves against the
// login-shell PATH that terminal inherits. When detection found the launcher
// *off* PATH — a user-set custom path, or the prefix install OpenClaw's desktop
// app creates under `~/.openclaw/bin` — the bare name resolves to nothing, so
// the absolute path is used instead, quoted for the shell that will run it.
export function launcherCommand(detectBin: string, path?: string): string {
  if (!path) return detectBin
  // cmd.exe has no escape for `"` inside a quoted token; POSIX shells take the
  // close-escape-reopen dance. Neither appears in a real install path, but a
  // username can contain a quote.
  return osType() === 'windows'
    ? `"${path.replace(/"/g, '')}"`
    : quoteAgentArgument(path)
}

// Snapshot the app proxy config (if enabled) into the payload the Rust
// `install_agent` / `open_agent_terminal` commands expect, so spawned installers
// and the launched agent can reach the network behind a region block. Returns
// undefined when no proxy is configured, so the commands omit proxy env.
export function buildProxyPayload():
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

/**
 * Installs the agent's binary, streaming its installer log into the launch
 * store. Returns whether the install succeeded; a failure is reported in a
 * toast. Does NOT manage the busy/phase state — the caller owns that so
 * install and what follows read as one action.
 */
export async function installIntegrationAgent(
  agent: IntegrationAgent,
  {
    t,
    detect,
  }: { t: Translate; detect: (agent: IntegrationAgent) => Promise<boolean> }
): Promise<boolean> {
  const { setLogs, setOpenLog } = useLaunchStore.getState()
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
}

/** The shell command that starts a terminal agent pointed at the server. */
function terminalCommand(
  agent: IntegrationAgent,
  model: string | null,
  { serverHost, serverPort, apiPrefix, apiKey }: AgentServerSettings,
  contextLength?: number
): string {
  // Off-PATH installs (custom path, or OpenClaw's app-managed prefix) have to
  // be spawned by absolute path; everything else keeps the bare binary name.
  // Read through the store rather than a render-closure copy: the caller may
  // have just run `detect`, whose result is not in its closure.
  const launcher = launcherCommand(
    agent.detectBin,
    useLaunchStore.getState().binPath[agent.id]
  )
  // OpenClaw's bare `openclaw` entry is the Crestodian setup/repair helper
  // (deterministic commands), not a chat. `openclaw chat` runs the embedded
  // local agent runtime, so the user lands straight in a conversation with the
  // configured model (no gateway needed). Goose's bare `goose` only prints
  // help; `goose session` starts an interactive chat. OpenHands reads our env
  // overrides only when launched with `--override-with-envs`. Everything else
  // runs its bare detect binary.
  if (agent.id === 'openclaw') return `${launcher} chat`
  if (agent.id === 'openhands') return `${launcher} --override-with-envs`
  if (agent.id === 'dsh') {
    // DeepSeek Harness is a browser app, not a terminal chat: a bare `dsh` has
    // no profile to hand its arguments to and only prints the launcher's own
    // help. `dsh web` is the alias for `--profile web`, which serves the UI on
    // http://127.0.0.1:3080. The first run of that profile initializes it
    // from a shipped template, so the URL can take a while to appear.
    return `${launcher} web`
  }
  const binary = useLaunchStore.getState().binPath[agent.id] || agent.detectBin
  if (agent.id === 'kilo' && model) {
    // Kilo opens on the model it last used before the one its config
    // selects; named on the command line, ours wins.
    return quotedAgentCommand(binary, ['--model', `atomic/${model}`], {})
  }
  if (agent.id === 'goose') {
    // Goose reads its provider from the environment: given to this session
    // only, never saved for the whole user. OPENAI_BASE_URL carries the API
    // prefix; with the window and output cap it compacts before the server
    // refuses.
    const apiUrl = `http://${agentConnectHost(serverHost)}:${serverPort}${apiPrefix}`
    return quotedAgentCommand(binary, ['session'], {
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: model ?? '',
      OPENAI_BASE_URL: apiUrl,
      OPENAI_API_KEY: apiKey || 'atomic',
      ...(contextLength
        ? {
            GOOSE_CONTEXT_LIMIT: String(contextLength),
            GOOSE_MAX_TOKENS: String(
              Math.min(8192, Math.floor(contextLength / 4))
            ),
          }
        : {}),
    })
  }
  if (agent.id === 'muse') {
    const apiUrl = `http://${agentConnectHost(serverHost)}:${serverPort}${apiPrefix}`
    return quotedAgentCommand(
      binary,
      [
        '--provider',
        'meta',
        '--base-url',
        apiUrl,
        ...(model ? ['--model', model] : []),
      ],
      { META_API_KEY: apiKey || 'atomic' }
    )
  }
  if (agent.id === 'codex') {
    return quotedAgentCommand(
      binary,
      ['--profile', 'atomic-chat'],
      apiKey ? { ATOMIC_CHAT_API_KEY: apiKey } : {}
    )
  }
  if (agent.id === 'copilot' && model) {
    // The endpoint, key and limits are our `atomic-chat` entry in Copilot's
    // providers.json; `--model <provider>/<id>` starts this run on it and
    // leaves the user's own default alone.
    return quotedAgentCommand(binary, ['--model', `atomic-chat/${model}`], {})
  }
  if (agent.id === 'poolside') {
    const apiUrl = `http://${agentConnectHost(serverHost)}:${serverPort}${apiPrefix}`
    return quotedAgentCommand(binary, [], {
      POOLSIDE_STANDALONE_BASE_URL: apiUrl.replace(/\/v1\/?$/, ''),
      POOLSIDE_API_KEY: apiKey || 'atomic',
      POOLSIDE_STANDALONE_MODEL: model ?? '',
    })
  }
  return launcher
}

/** Quote data for POSIX shells or PowerShell without evaluating its contents. */
function quoteAgentArgument(value: string, windows = false): string {
  return windows
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`
}

function quotedAgentCommand(
  binary: string,
  args: string[],
  env: Record<string, string>
): string {
  const windows = osType() === 'windows'
  const quote = (value: string) => quoteAgentArgument(value, windows)
  const command = [binary, ...args].map(quote).join(' ')
  if (!windows) {
    return [
      ...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`),
      command,
    ].join(' ')
  }
  // cmd.exe expands %, ! and metacharacters even inside many quoted forms.
  // Only base64 crosses cmd; PowerShell receives UTF-16LE literal arguments.
  // `& codex` resolves to npm's `codex.ps1` shim first, which the default
  // execution policy (Restricted on Windows client) refuses to run; Bypass
  // applies to this one process only.
  const script = [
    ...Object.entries(env).map(([key, value]) => `$env:${key}=${quote(value)}`),
    `& ${command}`,
  ].join('; ')
  const bytes = Array.from({ length: script.length }, (_, i) => {
    const code = script.charCodeAt(i)
    return String.fromCharCode(code & 255, code >> 8)
  }).join('')
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${btoa(bytes)}`
}

/**
 * An agent found only inside WSL cannot be connected from here: its config
 * is written on Windows and a Windows console starts it, and WSL 2's
 * localhost is not this PC. Says so in a toast and returns true; returns
 * false for every other agent.
 */
export function refuseWslOnlyAgent(
  agent: IntegrationAgent,
  t: Translate
): boolean {
  const { installed, viaWsl } = useLaunchStore.getState()
  if (!(installed[agent.id] && viaWsl[agent.id])) return false
  toast.warning(t('launch:toast.wslOnly', { name: agent.name }), {
    description: t('launch:toast.wslOnlyDesc', { name: agent.name }),
    duration: 10000,
  })
  return true
}

/**
 * What `open_agent_terminal` did: a new terminal, or the one already running
 * this agent brought forward (macOS).
 */
type TerminalOutcome = 'opened' | 'focused'

/**
 * What the terminal is for (`AgentTerminalInfo` in Rust): its title, the line
 * printed before the agent starts, and the window a later Connect brings
 * forward.
 */
function terminalInfo(
  agent: IntegrationAgent,
  model: string | null,
  { serverHost, serverPort, apiPrefix }: AgentServerSettings
) {
  return {
    agentId: agent.id,
    agentName: agent.name,
    endpoint: `http://${agentConnectHost(serverHost)}:${serverPort}${agent.endpointWithPrefix ? apiPrefix : ''}`,
    model,
  }
}

/** Opens the agent's own window or terminal; what it did, `null` if nothing. */
async function openAgent(
  agent: IntegrationAgent,
  { t, model, server }: OpenOptions
): Promise<TerminalOutcome | null> {
  // Zed is a desktop editor, not a terminal agent: its AI agent lives in its
  // own window. Launch the app directly (no terminal) — the config written
  // before points its `openai_compatible` "Atomic Chat" provider at the local
  // server, and the user drives the Agent Panel from there. Detection may
  // have found Zed off PATH (the DMG install links no `zed` CLI).
  if (agent.id === 'zed') {
    await invoke('launch_zed', {
      apiKey: server.apiKey || null,
      path: useLaunchStore.getState().binPath[agent.id] ?? null,
    })
    return 'opened'
  }
  // ZCode is a desktop app too, and it is never installed from here: the
  // provider file is written either way and read on its next start, so a
  // missing app is a pointer to the download, not a failure.
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
    return app.launched ? 'opened' : null
  }
  // OpenClaw also ships a desktop app (macOS `OpenClaw.app`, Windows Hub), and
  // it reads the very config written before — its Gateway owns the file and
  // hot-reloads it. So when the app is installed it *is* the destination, and
  // dropping the user into a terminal TUI would land them in the wrong window.
  if (agent.id === 'openclaw') {
    const app = await invoke<{ installed: boolean; launched: boolean }>(
      'launch_openclaw_app'
    )
    if (app.launched) return 'opened'
    if (app.installed) {
      // Windows Hub installs per-user with no documented path or AUMID to
      // launch it by, so hand the user the one instruction we can give
      // confidently instead of guessing at a shortcut.
      toast.info(t('launch:toast.openclawAppReady'), {
        description: t('launch:toast.openclawAppReadyDesc'),
        duration: 10000,
      })
      return null
    }
  }
  if (refuseWslOnlyAgent(agent, t)) return null
  // The window the served model was loaded with, for the agent told it at
  // launch rather than in its config.
  const contextLength =
    agent.id === 'goose' ? await servedContextLength() : undefined
  const outcome = await invoke<TerminalOutcome | undefined>(
    'open_agent_terminal',
    {
      command: terminalCommand(agent, model, server, contextLength),
      proxy: buildProxyPayload(),
      agent: terminalInfo(agent, model, server),
    }
  )
  return outcome === 'focused' ? 'focused' : 'opened'
}

/** macOS refused to let Atomic Chat drive Terminal (Automation, -1743). */
function automationDenied(message: string): boolean {
  return /-1743|not authori[sz]ed to send apple events/i.test(message)
}

type OpenOptions = {
  t: Translate
  /** The model the agent's config was written for. */
  model: string | null
  server: AgentServerSettings
}

/**
 * Starts an agent whose config already points at the Local API Server: its
 * desktop app, or a terminal running it — or, while the terminal Atomic Chat
 * opened for it still runs it, brings that one forward. A failure is a
 * warning toast, never a throw — the config is written either way. Resolves
 * whether the agent was opened, and records it in the launch store for this
 * run of the server.
 */
export async function openIntegrationAgent(
  agent: IntegrationAgent,
  options: OpenOptions
): Promise<boolean> {
  try {
    const outcome = await openAgent(agent, options)
    if (!outcome) return false
    useLaunchStore.getState().markOpened(agent.id, options.model, {
      reopened: outcome === 'focused',
    })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    toast.warning(
      options.t('launch:toast.terminalFailed', { name: agent.name }),
      {
        description: automationDenied(message)
          ? options.t('launch:toast.terminalNotAllowedDesc')
          : message,
      }
    )
    return false
  }
}
