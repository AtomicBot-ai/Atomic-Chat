export type IntegrationKind = 'coding' | 'assistant' | 'editor'

/**
 * Ordered manual-setup instructions shown inside an editor card. These mirror
 * the per-editor pages other local-model tools ship (e.g. Ollama's
 * "IDEs & Editors" docs): VS Code (Copilot BYOK), JetBrains AI Assistant, and
 * Xcode all store the provider in secret/IDE storage with no writable config
 * file, so the connection details have to be pasted into the editor's own UI.
 * The strings are intentionally not localized — they describe product UI whose
 * labels are English in every locale (matching the non-localized product names
 * already used on this page).
 */
export type EditorSetup = {
  /** Stable id passed to the Rust `launch_editor` command. */
  launchId: string
  /** Ordered manual steps to finish setup inside the editor. */
  steps: string[]
}

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
}

export const INTEGRATION_AGENTS: IntegrationAgent[] = [
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
      'Use your local models in GitHub Copilot Chat via an OpenAI-compatible provider.',
    kind: 'editor',
    detectBin: 'code',
    docsUrl: 'https://code.visualstudio.com/docs/copilot/overview',
    installable: false,
    configurable: false,
    requiresModel: false,
    endpointWithPrefix: true,
    editor: {
      launchId: 'vscode',
      steps: [
        'Sign in to GitHub Copilot (the free plan is enough).',
        'Open the Copilot Chat view, then click the model picker and choose "Manage Models…".',
        'Pick "OpenAI Compatible" (BYOK), paste the copied Base URL and API key, and save.',
        'Select the Atomic Chat model from the model picker to start chatting.',
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
    docsUrl: 'https://www.jetbrains.com/help/ai-assistant/',
    installable: false,
    configurable: false,
    requiresModel: false,
    endpointWithPrefix: true,
    editor: {
      launchId: 'jetbrains',
      steps: [
        'Open Settings → Tools → AI Assistant → Models.',
        'Enable third-party / local providers, then add an "OpenAI-compatible endpoint".',
        'Paste the copied Base URL (and API key if prompted) and apply.',
        'Select the Atomic Chat model as the provider for AI Assistant.',
      ],
    },
  },
  {
    id: 'xcode',
    name: 'Xcode',
    description:
      "Use your local models with Xcode's Coding Intelligence via a locally hosted model.",
    kind: 'editor',
    detectBin: 'xed',
    docsUrl: 'https://developer.apple.com/xcode/',
    installable: false,
    configurable: false,
    requiresModel: false,
    endpointWithPrefix: true,
    editor: {
      launchId: 'xcode',
      steps: [
        'Open Xcode → Settings → Intelligence (requires Xcode 26 or newer, macOS only).',
        'Click "Add a Model Provider" and choose "Locally Hosted".',
        'Enter the port from the copied Base URL (default 1337); Xcode adds the /v1 path itself.',
        'Restart Xcode if the models do not appear, then pick the Atomic Chat model.',
      ],
    },
  },
]
