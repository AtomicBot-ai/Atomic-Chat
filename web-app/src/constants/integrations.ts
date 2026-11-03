export type IntegrationKind = 'coding' | 'assistant' | 'editor'

/**
 * Ordered manual-setup instructions shown inside an editor card. These mirror
 * the per-editor pages other local-model tools ship (e.g. Ollama's
 * "IDEs & Editors" docs): VS Code (Copilot Chat's Custom Endpoint), JetBrains
 * AI Assistant, and Xcode all keep the provider in their own settings or
 * secret storage, so the connection details have to be pasted into the
 * editor's own UI. Each step is an i18n key; the editors' menu labels stay
 * English inside the translations.
 */
export type EditorSetup = {
  /** Stable id passed to the Rust `launch_editor` command. */
  launchId: string
  /** i18n keys of the ordered manual steps to finish setup in the editor. */
  steps: string[]
}

/** A desktop OS an integration can be limited to. */
export type DesktopPlatform = 'macos' | 'windows' | 'linux'

export type IntegrationAgent = {
  /** Stable id used by the Rust install/configure commands. */
  id: string
  /** Display name (not localized - these are product names). */
  name: string
  /** Short tagline shown under the name. */
  description: string
  kind: IntegrationKind
  /** Binary probed via `which`/`where` to detect a local install. */
  detectBin: string
  /** Official documentation / install URL. */
  docsUrl: string
  /** Whether the Install button spawns an installer through `install_agent`. */
  installable: boolean
  /** Whether the Enable button writes a config pointing at the local server. */
  configurable: boolean
  /** Whether a model must be picked before the agent can be enabled. */
  requiresModel: boolean
  /**
   * When true the local endpoint is passed WITH the API prefix (`/v1`).
   * Claude Code expects the bare host:port and appends its own path.
   */
  endpointWithPrefix: boolean
  /**
   * Present only for `kind: 'editor'`. GUI editors can't have their provider
   * written to a file (it lives in secret/IDE storage), so instead of the
   * write-config "Run" flow they expose Launch + Copy settings + manual steps.
   */
  editor?: EditorSetup
  /** The only desktop OSes the integration exists on; absent means all. */
  platforms?: DesktopPlatform[]
}

const CATALOG: IntegrationAgent[] = [
  {
    id: 'kilo',
    name: 'Kilo Code',
    description: 'All-in-one open-source agentic coding agent.',
    kind: 'coding',
    detectBin: 'kilo',
    docsUrl: 'https://kilo.ai/docs',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's agentic coding tool for your terminal.",
    kind: 'coding',
    detectBin: 'claude',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    installable: true,
    configurable: true,
    requiresModel: false,
    endpointWithPrefix: false,
  },
  {
    id: 'pi',
    name: 'pi',
    description: 'A terminal-based, self-extensible AI coding agent.',
    kind: 'coding',
    detectBin: 'pi',
    docsUrl: 'https://github.com/earendil-works/pi',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    description: 'An AI coding agent you can delegate real work to, by OpenAI.',
    kind: 'coding',
    detectBin: 'codex',
    docsUrl: 'https://github.com/openai/codex',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'An open-source AI coding assistant that runs in your terminal.',
    kind: 'coding',
    detectBin: 'opencode',
    docsUrl: 'https://opencode.ai',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'openclaude',
    name: 'OpenClaude',
    description:
      'Open-source coding-agent CLI for cloud and local model providers.',
    kind: 'coding',
    detectBin: 'openclaude',
    docsUrl: 'https://github.com/Gitlawb/openclaude',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'cline',
    name: 'Cline CLI',
    description: 'Autonomous open-source coding agent for your terminal.',
    kind: 'coding',
    detectBin: 'cline',
    docsUrl: 'https://docs.cline.bot/cline-cli/getting-started',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    description: 'Plugin-based open-source agent harness by DeepSeek AI.',
    kind: 'coding',
    detectBin: 'dsh',
    docsUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    installable: true,
    configurable: true,
    // A provider route DeepSeek Harness does not ship in its catalog is only
    // valid with a non-empty model list, and it rejects the whole `llm-pi-ai`
    // section when one route is invalid -- so an unset model would take the
    // user's other providers down with it, not merely fail to help.
    requiresModel: true,
    // The route is declared with the `openai-completions` protocol, whose
    // `baseURL` is expected to already carry the `/v1` prefix.
    endpointWithPrefix: true,
  },
  {
    id: 'zed',
    name: 'Zed',
    description: 'High-performance code editor with a built-in AI agent.',
    kind: 'coding',
    detectBin: 'zed',
    docsUrl: 'https://zed.dev/docs/ai/llm-providers',
    installable: true,
    configurable: true,
    requiresModel: true,
    // Registered as an `openai_compatible` provider, whose `api_url` is the
    // OpenAI API root with the `/v1` prefix.
    endpointWithPrefix: true,
  },
  {
    id: 'zcode',
    name: 'ZCode',
    description: "Z.ai's desktop AI coding workspace.",
    kind: 'coding',
    detectBin: 'zcode',
    docsUrl: 'https://zcode.z.ai/en/docs/configuration',
    // ZCode ships as a desktop app from zcode.z.ai (its CLI is not published),
    // so there is nothing for `install_agent` to run. Enabling only writes its
    // provider file, which ZCode reads whenever it runs — installed or not yet.
    installable: false,
    configurable: true,
    requiresModel: true,
    // Stored as an `openai-chat-completions` provider, whose `baseUrl` is the
    // OpenAI API root ZCode appends `/chat/completions` to.
    endpointWithPrefix: true,
  },
  {
    id: 'mimo',
    name: 'MiMo Code',
    description: "Xiaomi's open-source agentic coding tool for your terminal.",
    kind: 'coding',
    detectBin: 'mimo',
    docsUrl: 'https://mimo.xiaomi.com/mimocode/',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'droid',
    name: 'Droid',
    description: "Factory.ai's agentic software development tool.",
    kind: 'coding',
    detectBin: 'droid',
    docsUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    description: "GitHub's agentic coding tool, in your terminal.",
    kind: 'coding',
    detectBin: 'copilot',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'openhands',
    name: 'OpenHands',
    description: 'Open-source AI agent that develops software like a human dev.',
    kind: 'coding',
    detectBin: 'openhands',
    docsUrl: 'https://docs.openhands.dev/openhands/usage/cli/installation',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'poolside',
    name: 'Poolside',
    description: 'Coding agent CLI with standalone mode.',
    kind: 'coding',
    detectBin: 'pool',
    docsUrl: 'https://docs.poolside.ai/cli',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'goose',
    name: 'Goose',
    description: "Block's open-source AI agent that runs, edits, and tests code.",
    kind: 'coding',
    detectBin: 'goose',
    docsUrl: 'https://block.github.io/goose/',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: false,
  },
  {
    id: 'muse',
    name: 'Muse Code',
    description: "Meta's multi-agent coding tool for your terminal.",
    kind: 'coding',
    detectBin: 'muse',
    docsUrl: 'https://developer.meta.com/ai/products/muse-code/',
    installable: true,
    configurable: true,
    requiresModel: true,
    // `--base-url` replaces the Meta Model API root (`https://api.meta.ai/v1`),
    // onto which Muse appends `/responses` itself -- the same Responses wire
    // protocol Codex CLI speaks, which the local server already serves.
    endpointWithPrefix: true,
  },
  {
    id: 'atomic-agent',
    name: 'Atomic Agent',
    description:
      'Local-first agent that browses, edits files, and runs commands.',
    kind: 'assistant',
    detectBin: 'atomic-agent',
    docsUrl: 'https://github.com/AtomicBot-ai/atomic-agent',
    installable: true,
    configurable: true,
    requiresModel: true,
    // Atomic Agent stores an `openai-compatible` provider, whose `baseUrl` is
    // the OpenAI API root. It normalises a trailing `/v1` away itself, but the
    // stored value should still read as the base URL the user would paste.
    endpointWithPrefix: true,
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    description: 'Self-improving AI agent built by Nous Research.',
    kind: 'assistant',
    detectBin: 'hermes',
    docsUrl: 'https://github.com/NousResearch/hermes-agent',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Personal AI assistant that bridges messaging apps to coding agents.',
    kind: 'assistant',
    detectBin: 'openclaw',
    docsUrl: 'https://docs.openclaw.ai',
    installable: true,
    configurable: true,
    requiresModel: true,
    endpointWithPrefix: true,
  },
  {
    id: 'vscode',
    name: 'VS Code',
    description:
      'Use your local models in GitHub Copilot Chat.',
    kind: 'editor',
    detectBin: 'code',
    docsUrl: 'https://code.visualstudio.com/docs/copilot/customization/language-models',
    installable: false,
    configurable: false,
    requiresModel: false,
    endpointWithPrefix: true,
    editor: {
      launchId: 'vscode',
      steps: [
        'launch:editorSteps.vscode.open',
        'launch:editorSteps.vscode.add',
        'launch:editorSteps.vscode.paste',
        'launch:editorSteps.vscode.pick',
      ],
    },
  },
  {
    id: 'jetbrains',
    name: 'JetBrains',
    description:
      'Connect AI Assistant in IntelliJ, PyCharm, WebStorm and other JetBrains IDEs.',
    kind: 'editor',
    detectBin: 'idea',
    docsUrl: 'https://www.jetbrains.com/help/ai-assistant/use-custom-models.html',
    installable: false,
    configurable: false,
    requiresModel: false,
    endpointWithPrefix: true,
    editor: {
      launchId: 'jetbrains',
      steps: [
        'launch:editorSteps.jetbrains.open',
        'launch:editorSteps.jetbrains.provider',
        'launch:editorSteps.jetbrains.assign',
        'launch:editorSteps.jetbrains.agents',
      ],
    },
  },
  {
    id: 'xcode',
    name: 'Xcode',
    description:
      "Use your local models with Xcode's Coding Intelligence.",
    kind: 'editor',
    // Found as `Xcode*.app`: `/usr/bin/xed` is a system shim that exists
    // without Xcode.
    detectBin: 'xcode',
    docsUrl:
      'https://developer.apple.com/documentation/xcode/setting-up-coding-intelligence',
    installable: false,
    configurable: false,
    requiresModel: false,
    endpointWithPrefix: true,
    platforms: ['macos'],
    editor: {
      launchId: 'xcode',
      steps: [
        'launch:editorSteps.xcode.open',
        'launch:editorSteps.xcode.add',
        'launch:editorSteps.xcode.port',
        'launch:editorSteps.xcode.pick',
      ],
    },
  },
]

/** The desktop OS this build runs on; `null` outside the desktop app. */
export function currentDesktopPlatform(): DesktopPlatform | null {
  if (IS_MACOS) return 'macos'
  if (IS_WINDOWS) return 'windows'
  if (IS_LINUX) return 'linux'
  return null
}

/**
 * The integrations that exist on `platform` (Xcode only on macOS). With the
 * platform unknown, all of them.
 */
export function integrationsFor(
  platform: DesktopPlatform | null
): IntegrationAgent[] {
  return CATALOG.filter(
    (agent) =>
      !platform || !agent.platforms || agent.platforms.includes(platform)
  )
}

export const INTEGRATION_AGENTS: IntegrationAgent[] = integrationsFor(
  currentDesktopPlatform()
)

/**
 * The order the Server lists integrations in: Claude Code, Codex and Atomic
 * Agent first, then the rest by tokens on OpenRouter's app ranking (coding,
 * This Month, read 2026-10-27; DeepSeek Harness by its place on the daily
 * board, it is not on the monthly one). Agents OpenRouter does not attribute
 * follow in catalog order, editors last.
 */
const SERVER_AGENT_ORDER = [
  'claude-code',
  'codex',
  'atomic-agent',
  'hermes',
  'kilo',
  'cline',
  'pi',
  'openclaw',
  'dsh',
  'openhands',
  'zcode',
  'zed',
  'goose',
  'mimo',
]

const serverRank = (agent: IntegrationAgent): number => {
  const ranked = SERVER_AGENT_ORDER.indexOf(agent.id)
  if (ranked !== -1) return ranked
  return SERVER_AGENT_ORDER.length + (agent.kind === 'editor' ? 1 : 0)
}

/** Every integration in the Server's order; the sort keeps catalog order on ties. */
export const SERVER_AGENTS: IntegrationAgent[] = [...INTEGRATION_AGENTS].sort(
  (a, b) => serverRank(a) - serverRank(b)
)
