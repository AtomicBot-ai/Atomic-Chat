import { IconAlertTriangle, IconCheck } from '@tabler/icons-react'
import { useState } from 'react'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { API_KEY_PLACEHOLDER } from '@/lib/embedding/examples'
import {
  probeLocalApiServer,
  type LocalApiServerProbe,
} from '@/utils/localApiServerControl'

import { useLocalApiServerUrl } from './ConnectionDetails'
import { ServerButton, ServerCopyButton } from './ServerPageParts'

export type ExampleLanguage = 'curl' | 'python'

/** Stands in for the model id until the server has one to name. */
export const MODEL_PLACEHOLDER = 'MODEL_ID'

/**
 * A chat completion against the Local API Server, ready to paste. The key
 * header is only there when the server wants one, and never with the key.
 */
export function chatCompletionExample(
  language: ExampleLanguage,
  baseUrl: string,
  model: string,
  authRequired: boolean
): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (language === 'python') {
    const key = authRequired ? API_KEY_PLACEHOLDER : 'not-needed'
    return [
      'from openai import OpenAI',
      '',
      `client = OpenAI(base_url=${JSON.stringify(base)}, api_key=${JSON.stringify(key)})`,
      'response = client.chat.completions.create(',
      `    model=${JSON.stringify(model)},`,
      '    messages=[{"role": "user", "content": "Hello"}],',
      ')',
      'print(response.choices[0].message.content)',
    ].join('\n')
  }
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Hello' }],
  }).replace(/'/g, "'\\''")
  return [
    `curl ${base}/chat/completions \\`,
    ...(authRequired
      ? [`  -H 'Authorization: Bearer ${API_KEY_PLACEHOLDER}' \\`]
      : []),
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${body}'`,
  ].join('\n')
}

/**
 * Server → Connections, "Try a request": an example to copy in the client's
 * language, and a real test request against the running server.
 */
export function TryRequest() {
  const { t } = useTranslation()
  const url = useLocalApiServerUrl()
  const apiKey = useLocalApiServer((state) => state.apiKey)
  const defaultModel = useLocalApiServer(
    (state) => state.defaultModelLocalApiServer
  )
  const running = useAppState((state) => state.serverStatus === 'running')
  const loadedModel = useAppState((state) => state.activeModels[0])
  const [language, setLanguage] = useState<ExampleLanguage>('curl')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<LocalApiServerProbe | null>(null)

  const model = loadedModel ?? defaultModel?.model ?? MODEL_PLACEHOLDER
  const example = chatCompletionExample(
    language,
    url,
    model,
    apiKey.trim() !== ''
  )

  const sendTest = async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult(await probeLocalApiServer(url, apiKey))
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="sp-panel">
      <div className="sp-row">
        <h2>{t('api:connections.tryTitle')}</h2>
        <select
          aria-label={t('api:connections.language')}
          value={language}
          onChange={(event) =>
            setLanguage(event.target.value as ExampleLanguage)
          }
        >
          <option value="curl">cURL</option>
          <option value="python">Python</option>
        </select>
      </div>
      <pre>{example}</pre>
      <div className="sp-actions">
        <ServerCopyButton
          value={example}
          label={t('api:connections.copyExample')}
        />
        <ServerButton
          primary
          disabled={!running || testing}
          onClick={() => void sendTest()}
        >
          {t('api:connections.sendTest')}
        </ServerButton>
      </div>
      {!running && <p>{t('api:connections.startToTest')}</p>}
      {result &&
        (result.ok ? (
          <div role="status" className="sp-note sp-positive">
            <IconCheck size={16} />
            {t('api:connections.testOk', {
              ms: result.latencyMs,
              count: result.modelCount,
            })}
          </div>
        ) : (
          <div role="alert" className="sp-note sp-negative">
            <IconAlertTriangle size={16} />
            <span className="min-w-0 break-words">
              {result.httpStatus === 401 || result.httpStatus === 403
                ? t('api:connections.testUnauthorized', {
                    status: result.httpStatus,
                  })
                : t('api:connections.testFailed', {
                    message: result.message.slice(0, 200),
                  })}
            </span>
          </div>
        ))}
    </section>
  )
}
