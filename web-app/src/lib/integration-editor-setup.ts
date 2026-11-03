import type { IntegrationAgent } from '@/constants/integrations'

/** What an editor's provider settings need from the Local API Server. */
export type EditorConnection = {
  /** OpenAI API root, with the server's prefix (`http://127.0.0.1:1337/v1`). */
  baseUrl: string
  /** The server's key, or a placeholder when it has none. */
  apiKey: string
  model: string | null
  /** The window the served model was loaded with, when known. */
  contextLength?: number
}

const MODEL_PLACEHOLDER = '(load a model in a chat first)'

/** A quarter of the window for output, at most 8192: what agents get too. */
const outputCap = (contextLength: number) =>
  Math.max(1, Math.min(8192, Math.floor(contextLength / 4)))

/**
 * The provider entry for VS Code's `chatLanguageModels.json` (Chat: Manage
 * Language Models → Add Models → Custom Endpoint). The key is left out: VS
 * Code keeps the one entered in that flow in its secret storage and refers
 * to it from the entry it writes.
 */
export function vscodeLanguageModelEntry(connection: EditorConnection) {
  const model = connection.model ?? MODEL_PLACEHOLDER
  const known = connection.contextLength && connection.contextLength > 0
  return {
    name: 'Atomic Chat',
    vendor: 'customendpoint',
    apiType: 'chat-completions',
    models: [
      {
        id: model,
        name: model,
        url: `${connection.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        toolCalling: true,
        vision: false,
        ...(known
          ? {
              maxInputTokens: connection.contextLength,
              maxOutputTokens: outputCap(connection.contextLength as number),
            }
          : {}),
      },
    ],
  }
}

/** The port in a base URL, defaulting the way `http:` does. */
function portOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).port || '80'
  } catch {
    return ''
  }
}

/**
 * What Copy settings puts on the clipboard for `agent`: exactly what its
 * provider settings ask for.
 */
export function editorClipboardText(
  agent: IntegrationAgent,
  connection: EditorConnection
): string {
  if (agent.id === 'vscode') {
    return JSON.stringify(vscodeLanguageModelEntry(connection), null, 2)
  }
  if (agent.id === 'xcode') {
    // "Locally Hosted" takes a port and nothing else.
    return `Port: ${portOf(connection.baseUrl)}`
  }
  const lines = [
    `Base URL: ${connection.baseUrl}`,
    `API key: ${connection.apiKey}`,
    `Model: ${connection.model ?? MODEL_PLACEHOLDER}`,
  ]
  if (agent.id === 'jetbrains' && connection.contextLength) {
    lines.push(`Context window: ${connection.contextLength}`)
  }
  return lines.join('\n')
}

/** A warning an editor card shows: an i18n key and its values. */
export type EditorWarning = {
  key: string
  values?: Record<string, string>
}

/**
 * Server settings that keep an editor from connecting at all. Xcode's
 * "Locally Hosted" provider has no key field and always calls `/v1/...` on
 * the port it is given.
 */
export function editorWarnings(
  agent: IntegrationAgent,
  server: { apiKey: string; apiPrefix: string }
): EditorWarning[] {
  if (agent.id !== 'xcode') return []
  const warnings: EditorWarning[] = []
  if (server.apiKey) warnings.push({ key: 'launch:editorWarnings.xcodeApiKey' })
  if (server.apiPrefix.replace(/\/+$/, '') !== '/v1') {
    warnings.push({
      key: 'launch:editorWarnings.xcodePrefix',
      values: { prefix: server.apiPrefix || '/' },
    })
  }
  return warnings
}
