import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { ONBOARDING_REMINDER_MODEL_HF_REPO } from '@/constants/models'
import { useModelProvider } from '@/hooks/useModelProvider'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  switchToModel: vi.fn(() => Promise.resolve()),
  capture: vi.fn(),
  pullModelWithMetadata: vi.fn(),
  fetchHuggingFaceRepo: vi.fn(),
  convertHfRepoToCatalogModel: vi.fn(),
  addLocalDownloadingModel: vi.fn(),
  clearResumableDownload: vi.fn(),
  chatgptSubscriptionAvailable: true,
}))

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
}))

vi.mock('posthog-js', () => ({
  default: { capture: mocks.capture },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}))

// Unmocked, the real store reports no RAM and no GPU on a test host.
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({ tier: 'vram_8', profile: null, ready: true }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: string }) => unknown
  ) => selector({ huggingfaceToken: '' }),
}))

vi.mock('@/hooks/useDownloadStore', () => {
  const state = {
    downloads: {},
    localDownloadingModels: new Set<string>(),
    resumableDownloads: new Set<string>(),
    addLocalDownloadingModel: mocks.addLocalDownloadingModel,
    clearResumableDownload: mocks.clearResumableDownload,
  }
  const useDownloadStore = (selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state
  useDownloadStore.getState = () => state
  return { useDownloadStore }
})

// The subscription button is desktop-only in production; pin it on so the
// "offered in every branch" assertions do not depend on the test platform.
vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: {
    get chatgptSubscription() {
      return mocks.chatgptSubscriptionAvailable
    },
  },
}))

import { ReplyModelGate } from '../ReplyModelGate'

const catalogModel: CatalogModel = {
  model_name: ONBOARDING_REMINDER_MODEL_HF_REPO,
  developer: 'AtomicChat',
  downloads: 0,
  quants: [
    {
      model_id: 'AtomicChat/Qwen3.5-4B-Q4_K_M',
      path: 'https://example.test/Qwen3.5-4B-Q4_K_M.gguf',
      file_size: '2.5 GB',
    },
  ],
} as CatalogModel

const model = (id: string) => ({ id }) as Model

const localProvider = (models: Model[]) =>
  ({
    provider: 'llamacpp-upstream',
    active: true,
    models,
    settings: [],
  }) as ModelProvider

const cloudProvider = () =>
  ({
    provider: 'openai',
    active: true,
    api_key: 'sk-test',
    models: [model('gpt-a')],
    settings: [
      {
        key: 'api-key',
        title: 'API key',
        description: '',
        controller_type: 'input',
        controller_props: { value: 'sk-test' },
      },
    ],
  }) as ModelProvider

/** A provider list with nothing usable, so the widget takes the empty branch. */
const unconnectedCloud = () =>
  ({ ...cloudProvider(), api_key: '', models: [] }) as ModelProvider

/** The subscription entry, present but not signed into. */
const subscriptionProvider = () =>
  ({
    provider: 'chatgpt',
    active: true,
    models: [],
    settings: [],
  }) as ModelProvider

function renderGate(providers: ModelProvider[]) {
  useModelProvider.setState({ providers })
  const onResolved = vi.fn()
  const onDismissed = vi.fn()
  const onOpenChange = vi.fn()
  const result = render(
    <ReplyModelGate
      open
      onOpenChange={onOpenChange}
      onResolved={onResolved}
      onDismissed={onDismissed}
    />
  )
  return { ...result, onResolved, onDismissed, onOpenChange }
}

const capturedEvent = (name: string) =>
  mocks.capture.mock.calls.find(([event]) => event === name)?.[1]

const capturedEvents = (name: string) =>
  mocks.capture.mock.calls
    .filter(([event]) => event === name)
    .map(([, props]) => props)

describe('ReplyModelGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.chatgptSubscriptionAvailable = true
    mocks.fetchHuggingFaceRepo.mockResolvedValue({ id: 'repo' })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(catalogModel)
    seedServiceHub({
      models: {
        fetchHuggingFaceRepo: mocks.fetchHuggingFaceRepo,
        convertHfRepoToCatalogModel: mocks.convertHfRepoToCatalogModel,
        pullModelWithMetadata: mocks.pullModelWithMetadata,
      } as never,
    })
  })

  it('starts the only model on the device without asking', async () => {
    const { onResolved } = renderGate([localProvider([model('only-one')])])

    await waitFor(() =>
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'only-one',
          providerName: 'llamacpp-upstream',
        })
      )
    )
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'auto_start', branch: 'auto_start' })
    )
    // Selected up front so the composer reflects the choice immediately.
    expect(useModelProvider.getState().selectedModel?.id).toBe('only-one')
  })

  it('offers the choice last-used-first when there are several', async () => {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'llamacpp-upstream', model: 'second' })
    )
    const { onResolved } = renderGate([
      localProvider([model('first'), model('second')]),
    ])

    const rows = await screen.findAllByTestId('reply-gate-option')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Second')
    expect(mocks.switchToModel).not.toHaveBeenCalled()

    fireEvent.click(rows[0])

    expect(mocks.switchToModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'second' })
    )
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'picked', branch: 'pick' })
    )
  })

  it('recommends a download when the device has nothing', async () => {
    const { onResolved } = renderGate([unconnectedCloud()])

    const download = await screen.findByRole('button', {
      name: /replyGate.download/,
    })
    fireEvent.click(download)

    expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
      'AtomicChat/Qwen3.5-4B-Q4_K_M',
      'https://example.test/Qwen3.5-4B-Q4_K_M.gguf',
      undefined,
      '',
      true,
      false
    )
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'download', branch: 'none' })
    )
    expect(capturedEvent('reply_model_gate_outcome')).toMatchObject({
      outcome: 'download',
      branch: 'none',
    })
  })

  it('offers both cloud routes even to a user who already has local models', async () => {
    renderGate([
      localProvider([model('a'), model('b')]),
      unconnectedCloud(),
      subscriptionProvider(),
    ])

    expect(
      await screen.findByRole('button', { name: 'chat:replyGate.connectCloud' })
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'chat:replyGate.connectSubscription' })
    ).toBeVisible()
  })

  it('hides the subscription route where the sign-in cannot run', async () => {
    mocks.chatgptSubscriptionAvailable = false
    renderGate([
      localProvider([model('a'), model('b')]),
      unconnectedCloud(),
      subscriptionProvider(),
    ])

    await screen.findAllByTestId('reply-gate-option')
    expect(
      screen.queryByRole('button', {
        name: 'chat:replyGate.connectSubscription',
      })
    ).toBeNull()
  })

  it('reports the impression with the device context that shaped it', async () => {
    renderGate([localProvider([model('a'), model('b')]), cloudProvider()])

    await waitFor(() =>
      expect(capturedEvent('reply_model_gate_shown')).toBeDefined()
    )
    expect(capturedEvent('reply_model_gate_shown')).toMatchObject({
      branch: 'pick',
      local_model_count: 2,
      cloud_provider_count: 1,
      has_cloud_connection: true,
      hardware_tier: 'vram_8',
    })
    // `status` is typed as a number globally in PostHog; a string written there
    // is ingested as null.
    expect(capturedEvent('reply_model_gate_shown')).not.toHaveProperty('status')
  })

  it('records a give-up as a dismissal, not as a resolution', async () => {
    const { onDismissed, onResolved, onOpenChange } = renderGate([
      localProvider([model('a'), model('b')]),
    ])
    await screen.findAllByTestId('reply-gate-option')

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    })

    await waitFor(() => expect(onDismissed).toHaveBeenCalled())
    expect(onResolved).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(capturedEvent('reply_model_gate_outcome')).toMatchObject({
      outcome: 'dismissed',
      branch: 'pick',
    })
  })

  it('does not report a dismissal when it closes on a started model', async () => {
    const { onDismissed } = renderGate([localProvider([model('only-one')])])
    await waitFor(() =>
      expect(capturedEvent('reply_model_gate_outcome')).toBeDefined()
    )

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    })

    // Closing a widget whose work is already under way is not giving up: the
    // auto-start stays the one and only outcome on record.
    expect(
      capturedEvents('reply_model_gate_outcome').map((event) => event.outcome)
    ).toEqual(['auto_start'])
    expect(onDismissed).not.toHaveBeenCalled()
  })
})
