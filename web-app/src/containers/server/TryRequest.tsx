import { IconAlertTriangle, IconCheck } from '@tabler/icons-react'
import { useState } from 'react'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  isEmbeddingOnlyModel,
  type AnswerableModelLike,
} from '@/lib/answerable-model'
import { API_KEY_PLACEHOLDER } from '@/lib/embedding/examples'
import {
  sendTestChatCompletion,
  TEST_REQUEST_MESSAGE,
  type LocalApiServerTestResult,
} from '@/utils/localApiServerControl'

import { useLocalApiServerUrl } from './ConnectionDetails'
import { ServerButton, ServerCopyButton, ServerSelect } from './ServerPageParts'

export type ExampleLanguage = 'curl' | 'python'

/** Stands in for the model id until the server has one to name. */
export const MODEL_PLACEHOLDER = 'MODEL_ID'

/** A loaded id as the provider store lists it, or just the id when none does. */
function describeModel(
  modelId: string,
  providers: ReadonlyArray<{
    models?: ReadonlyArray<AnswerableModelLike & { id: string }>
  }>
): AnswerableModelLike {
  for (const provider of providers) {
    const model = provider?.models?.find((m) => m.id === modelId)
    if (model) return model
  }
  return { id: modelId }
}

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
      `    messages=[{"role": "user", "content": ${JSON.stringify(TEST_REQUEST_MESSAGE)}}],`,
      ')',
      'print(response.choices[0].message.content)',
    ].join('\n')
  }
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: TEST_REQUEST_MESSAGE }],
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
 * language, and a test that sends that same request to the running server
 * (with a small `max_tokens`) and says how it went.
 */
export function TryRequest() {
  const { t } = useTranslation()
  const url = useLocalApiServerUrl()
  const apiKey = useLocalApiServer((state) => state.apiKey)
  const defaultModel = useLocalApiServer(
    (state) => state.defaultModelLocalApiServer
  )
  const running = useAppState((state) => state.serverStatus === 'running')
  const activeModels = useAppState((state) => state.activeModels)
  const providers = useModelProvider((state) => state.providers)
  // The first loaded model that can chat: project indexing loads an embedding
  // model beside it, which would only answer a chat completion with an error.
  const loadedModel = activeModels.find(
    (id) => !isEmbeddingOnlyModel(describeModel(id, providers))
  )
  const [language, setLanguage] = useState<ExampleLanguage>('curl')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<LocalApiServerTestResult | null>(null)

  const model = loadedModel ?? defaultModel?.model ?? MODEL_PLACEHOLDER
  // Without a model to name there is no request to send.
  const hasModel = model !== MODEL_PLACEHOLDER
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
      setResult(await sendTestChatCompletion(url, apiKey, model))
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="sp-panel">
      <div className="sp-row">
        <h2>{t('api:connections.tryTitle')}</h2>
        <ServerSelect
          label={t('api:connections.language')}
          value={language}
          options={[
            { value: 'curl', label: 'cURL' },
            { value: 'python', label: 'Python' },
          ]}
          onChange={(next) => setLanguage(next as ExampleLanguage)}
        />
      </div>
      <pre>{example}</pre>
      <div className="sp-actions">
        <ServerCopyButton
          value={example}
          label={t('api:connections.copyExample')}
        />
        <ServerButton
          primary
          disabled={!running || !hasModel || testing}
          onClick={() => void sendTest()}
        >
          {t('api:connections.sendTest')}
        </ServerButton>
      </div>
      {!running ? (
        <p>{t('api:connections.startToTest')}</p>
      ) : (
        !hasModel && <p>{t('api:connections.testNeedsModel')}</p>
      )}
      {result &&
        (result.ok ? (
          <div role="status" className="sp-note sp-positive">
            <IconCheck size={16} />
            {t('api:connections.testOk', {
              ms: result.latencyMs,
              model: result.model,
            })}
          </div>
        ) : (
          <div role="alert" className="sp-note sp-negative">
            <IconAlertTriangle size={16} />
            <span className="min-w-0 break-words">
              {testFailureText(result, loadedModel !== undefined, t)}
            </span>
          </div>
        ))}
    </section>
  )
}

/**
 * What a failed test means for the reader. The server answers 503 when no
 * model is loaded at all and 404 when the one asked for is not loaded; both
 * are said plainly rather than as a raw error. A 503 while a model is loaded
 * came from somewhere else (a cloud provider), so its own words are shown.
 */
function testFailureText(
  result: Extract<LocalApiServerTestResult, { ok: false }>,
  modelLoaded: boolean,
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  if (result.httpStatus === 401 || result.httpStatus === 403)
    return t('api:connections.testUnauthorized', { status: result.httpStatus })
  if (result.httpStatus === 503 && !modelLoaded)
    return t('api:connections.testNoModel')
  if (result.httpStatus === 404)
    return t('api:connections.testModelNotServed', { model: result.model })
  return t('api:connections.testFailed', {
    message: result.message.slice(0, 200),
  })
}
