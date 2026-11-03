import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-dom/client', () => {
  const createRoot = vi.fn(() => ({ render: vi.fn() }))
  return { default: { createRoot }, createRoot }
})
vi.mock('@tanstack/react-router', () => ({
  RouterProvider: () => null,
  createRouter: vi.fn(() => ({ navigate: vi.fn() })),
  createRootRoute: vi.fn(),
}))
vi.mock('../routeTree.gen', () => ({ routeTree: {} }))
vi.mock('../index.css', () => ({}))
vi.mock('../i18n', () => ({}))

const QWEN = 'Qwen2.5-0.5B-Instruct-Q4_K_M'
const qwen = { id: QWEN, capabilities: ['completion'] }
const provider = (name: string) => ({
  provider: name,
  active: true,
  models: [qwen],
  settings: [],
})

/** Boot the web app the way a window opened on `url` does. */
async function bootWindow(url: string) {
  window.history.replaceState(null, '', url)
  await import('../main')
  const { useModelProvider } = await import('../hooks/useModelProvider')
  const { selectedProvider, selectedModel } = useModelProvider.getState()
  return { provider: selectedProvider, model: selectedModel?.id ?? null }
}

const threadModel = (model: ThreadModel) =>
  `threadModel=${encodeURIComponent(JSON.stringify(model))}`

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = '<div id="root"></div>'
  // What the windows share: both llama.cpp providers list the same model, and
  // the last selection written is TurboQuant's, as the first B12 open left it.
  localStorage.setItem(
    'model-provider',
    JSON.stringify({
      state: {
        providers: [provider('llamacpp'), provider('llamacpp-upstream')],
        selectedProvider: 'llamacpp',
        selectedModel: qwen,
        deletedModels: [],
      },
      version: 15,
    })
  )
})

afterEach(() => {
  vi.resetModules()
  window.history.replaceState(null, '', '/')
})

/**
 * QA 2.2.29 B12: a chat on llama.cpp upstream opened in a new window started
 * on TurboQuant the first time and on no model at all the second.
 */
describe('a window opened for a chat', () => {
  it('starts on the provider and model the opening window chats with', async () => {
    const selection = await bootWindow(
      `/threads/thread-1?${threadModel({ id: QWEN, provider: 'llamacpp-upstream' })}`
    )

    expect(selection).toEqual({ provider: 'llamacpp-upstream', model: QWEN })
  })

  it('starts empty with preload off when it is handed no model', async () => {
    const selection = await bootWindow('/threads/thread-1')

    expect(selection).toEqual({ provider: '', model: null })
  })
})
