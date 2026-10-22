import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { CHATGPT_BASE_URL } from '@/constants/providers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useOnboardingStore } from '@/stores/onboarding-store'
import { useProviderKeyStatusStore } from '@/stores/provider-key-status-store'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  checkProviderEndpoint: vi.fn(),
  auth: {
    chatgptStatus: vi.fn(),
    chatgptLogin: vi.fn(),
    chatgptCancelLogin: vi.fn(),
    chatgptLogout: vi.fn(),
    chatgptModels: vi.fn(),
  },
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  }),
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

import { CloudStep } from '../steps/CloudStep'
import { useCloudProviderCount } from '../steps/cloudAvailability'

const keyed = (
  provider: string,
  extra: Partial<ModelProvider> = {}
): ModelProvider =>
  ({
    active: true,
    provider,
    api_key: '',
    base_url: `https://api.${provider}.example/v1`,
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description: '',
        controller_type: 'input',
        controller_props: { value: '' },
      },
    ],
    models: [{ id: `${provider}-model` }],
    ...extra,
  }) as ModelProvider

const chatgpt = (extra: Partial<ModelProvider> = {}): ModelProvider =>
  ({
    active: true,
    provider: 'chatgpt',
    api_key: '',
    base_url: CHATGPT_BASE_URL,
    settings: [],
    models: [],
    ...extra,
  }) as ModelProvider

/** What the app lists: cloud providers among a local engine and a server on this machine. */
const appProviders = (
  connected: Record<string, Partial<ModelProvider>> = {}
) => [
  keyed('openai', connected.openai),
  keyed('anthropic', connected.anthropic),
  {
    active: true,
    provider: 'llamacpp',
    persist: true,
    settings: [],
    models: [{ id: 'qwen3.5-4b' }],
  } as unknown as ModelProvider,
  keyed('ollama', { base_url: 'http://localhost:11434/v1' }),
  keyed('azure'),
  keyed('gemini', connected.gemini),
  keyed('openrouter', connected.openrouter),
  chatgpt(connected.chatgpt),
]

const seed = (providers: ModelProvider[]) =>
  useModelProvider.setState({ providers } as never)

const card = (label: string) =>
  within(
    screen.getByRole('group', { name: 'onboarding-cloud:providers' })
  ).getByRole('button', { name: label })

const keyInput = (label: string) =>
  screen.getByLabelText(`onboarding-cloud:keyFor ${label}`) as HTMLInputElement

const connectWith = (label: string, key: string) => {
  fireEvent.change(keyInput(label), { target: { value: key } })
  fireEvent.click(
    screen.getByRole('button', { name: 'setup:cloudStep.connect' })
  )
}

const apiKeyOf = (name: string) =>
  useModelProvider.getState().providers.find((p) => p.provider === name)
    ?.api_key

function renderStep() {
  const next = vi.fn()
  render(<CloudStep next={next} goTo={vi.fn()} handOff={vi.fn()} />)
  return { next }
}

// Unmounted before the shared teardown empties the service hub.
afterEach(cleanup)

describe('cloud step', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useProviderKeyStatusStore.setState({ statuses: {} })
    mocks.checkProviderEndpoint.mockResolvedValue({
      ok: true,
      latencyMs: 40,
      modelCount: 3,
    })
    mocks.auth.chatgptStatus.mockResolvedValue({ connected: false })
    mocks.auth.chatgptModels.mockResolvedValue([])
    seedServiceHub({
      providers: {
        checkProviderEndpoint: mocks.checkProviderEndpoint,
        updateSettings: vi.fn().mockResolvedValue(undefined),
      } as never,
      auth: mocks.auth as never,
    })
    seed(appProviders())
  })

  it('onboarding offers every app cloud provider with the shared logos', () => {
    renderStep()

    const group = screen.getByRole('group', {
      name: 'onboarding-cloud:providers',
    })
    // The Add provider gallery's order: the sign-in first, then demand.
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      'ChatGPT (Codex)',
      'OpenRouter',
      'Gemini',
      'OpenAI',
      'Anthropic',
    ])
    expect(
      within(group).getByRole('img', { name: 'openai - Logo' })
    ).toBeVisible()
    expect(
      within(group)
        .getByRole('img', { name: 'gemini - Logo' })
        .getAttribute('src')
    ).toBe('/images/model-provider/gemini.svg')
    // Selected first: the provider with nothing to paste.
    expect(card('ChatGPT (Codex)')).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', { name: 'onboarding-cloud:skip' })
    ).toBeInTheDocument()
  })

  it('connecting skips completed providers, wraps to remaining ones, and stops when all are connected', async () => {
    seed(
      appProviders({
        chatgpt: { models: [{ id: 'gpt-5.1-codex' }] as Model[] },
        gemini: { api_key: 'sk-gemini' },
        anthropic: { api_key: 'sk-anthropic' },
      })
    )
    const { next } = renderStep()

    // Connected before this run: shown as such, but nothing to Continue with.
    expect(card('Gemini')).toBeDisabled()
    expect(card('OpenRouter')).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', { name: 'onboarding-cloud:skip' })
    ).toBeInTheDocument()

    fireEvent.click(card('OpenAI'))
    connectWith('OpenAI', 'sk-openai')

    // Past Anthropic and the subscription, both connected, round to OpenRouter.
    expect(
      await screen.findByLabelText('onboarding-cloud:keyFor OpenRouter')
    ).toBeEnabled()
    expect(card('OpenAI')).toBeDisabled()
    expect(card('OpenAI')).toHaveClass('connected')
    expect(card('OpenAI')).toHaveAttribute(
      'aria-description',
      'onboarding-cloud:connected'
    )
    expect(apiKeyOf('openai')).toBe('sk-openai')
    expect(useOnboardingStore.getState().clouds).toEqual(['openai'])
    expect(keyInput('OpenRouter').value).toBe('')

    connectWith('OpenRouter', 'sk-openrouter')

    expect(
      await screen.findByRole('button', { name: 'onboarding-cloud:connected' })
    ).toBeDisabled()
    expect(keyInput('OpenRouter')).toBeDisabled()
    expect(useOnboardingStore.getState().clouds).toEqual([
      'openai',
      'openrouter',
    ])

    fireEvent.click(screen.getByRole('button', { name: 'onboarding:continue' }))
    expect(next).toHaveBeenCalledWith('continue')
  })

  it('says why a key was refused, and saves it anyway as not verified', async () => {
    mocks.checkProviderEndpoint.mockResolvedValue({
      ok: false,
      latencyMs: 70,
      modelCount: 0,
      httpStatus: 401,
      message: 'Authentication failed: invalid key.',
    })
    renderStep()

    fireEvent.click(card('OpenRouter'))
    connectWith('OpenRouter', 'sk-bad')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'setup:cloudStep.keyRejected OpenRouter Authentication failed: invalid key.'
    )
    expect(keyInput('OpenRouter')).toHaveAttribute('aria-invalid', 'true')
    expect(apiKeyOf('openrouter')).toBe('')
    expect(useOnboardingStore.getState().clouds).toEqual([])

    fireEvent.click(
      screen.getByRole('button', { name: 'setup:cloudStep.saveAnyway' })
    )

    await waitFor(() => expect(apiKeyOf('openrouter')).toBe('sk-bad'))
    expect(useOnboardingStore.getState().clouds).toEqual(['openrouter'])
    expect(card('OpenRouter')).toHaveAttribute(
      'aria-description',
      'onboarding-cloud:notVerified'
    )
    expect(
      within(card('OpenRouter')).getByText('onboarding-cloud:notVerified')
    ).toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalledWith(
      'setup:cloudStep.savedUnverified OpenRouter',
      {
        description:
          'setup:cloudStep.keyRejected OpenRouter Authentication failed: invalid key.',
      }
    )
  })

  it('signs in to the ChatGPT subscription and moves on to the next provider', async () => {
    mocks.auth.chatgptLogin.mockResolvedValue({
      connected: true,
      email: 'someone@example.test',
      plan_type: 'Plus',
    })
    mocks.auth.chatgptModels.mockResolvedValue([
      { id: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex', listed: true },
    ])
    renderStep()

    const signIn = await screen.findByRole('button', {
      name: 'setup:cloudStep.subscriptionConnect',
    })
    await waitFor(() => expect(signIn).toBeEnabled())
    fireEvent.click(signIn)

    expect(
      await screen.findByLabelText('onboarding-cloud:keyFor OpenRouter')
    ).toBeEnabled()
    expect(useOnboardingStore.getState().clouds).toEqual(['chatgpt'])
    expect(card('ChatGPT (Codex)')).toHaveClass('connected')
    expect(
      useModelProvider
        .getState()
        .providers.find((p) => p.provider === 'chatgpt')
        ?.models.map((model) => model.id)
    ).toEqual(['gpt-5.1-codex'])
  })

  it('counts every provider it offers, connected ones included', () => {
    const before = renderHook(() => useCloudProviderCount())
    expect(before.result.current).toBe(5)

    seed(appProviders({ openai: { api_key: 'sk-openai' } }))
    const after = renderHook(() => useCloudProviderCount())
    expect(after.result.current).toBe(5)

    seed([])
    const empty = renderHook(() => useCloudProviderCount())
    expect(empty.result.current).toBe(0)
  })
})
