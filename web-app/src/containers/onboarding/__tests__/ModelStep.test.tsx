import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'

import type { LocalModelCandidate } from '@/services/models/localScan'
import type { CatalogModel, ModelQuant } from '@/services/models/types'
import { useOnboardingStore } from '@/stores/onboarding-store'

import type { DownloadOption, ModelOption } from '../useModelOptions'

const mocks = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  startGguf: vi.fn(() => 'Qwen3.5-4B-Q4_K_M'),
  startMlx: vi.fn(async () => true),
  importBackground: vi.fn(),
  engineImport: vi.fn(async () => undefined),
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))
vi.mock('@janhq/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EngineManager: {
    instance: () => ({ get: () => ({ import: mocks.engineImport }) }),
  },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))
vi.mock('../useModelOptions', () => ({
  useModelOptions: () => mocks.options,
}))
vi.mock('@/lib/onboarding/downloads', () => ({
  startGgufCatalogDownload: mocks.startGguf,
  startMlxCatalogDownload: mocks.startMlx,
  importCandidatesInBackground: mocks.importBackground,
  providerForCandidate: () => 'llamacpp-upstream',
}))

import { ModelStep } from '../steps/ModelStep'

const catalog = {
  model_name: 'unsloth/Qwen3.5-4B-GGUF',
  developer: 'unsloth',
} as CatalogModel

const download = (overrides: Partial<DownloadOption> = {}): DownloadOption => ({
  kind: 'download',
  key: 'download:qwen',
  title: 'Qwen3.5 4B',
  detail: null,
  iconSrc: null,
  catalog,
  variant: { model_id: 'Qwen3.5-4B-Q4_K_M', path: 'q4.gguf' } as ModelQuant,
  isMlx: false,
  taskId: 'Qwen3.5-4B-Q4_K_M',
  provider: 'llamacpp-upstream',
  matchIds: ['Qwen3.5-4B-Q4_K_M', 'unsloth/Qwen3_5-4B-Q4_K_M'],
  sizeLabel: '2.5 GB',
  sizeBytes: 2.5 * 1024 ** 3,
  fit: 'ok',
  bestFit: true,
  position: 0,
  ...overrides,
})

const found: ModelOption = {
  kind: 'scan',
  key: 'scan:/lm/llama.gguf',
  title: 'Llama 3.1 8B',
  detail: 'lmstudio',
  iconSrc: null,
  provider: 'llamacpp-upstream',
  matchIds: ['llama.gguf'],
  candidate: {
    id: 'llama.gguf',
    displayName: 'Llama 3.1 8B',
    path: '/lm/llama.gguf',
    format: 'gguf',
    source: 'lmstudio',
    runnable: true,
  } as LocalModelCandidate,
}

function withOptions({
  onDevice = [],
  recommended = [download()],
}: {
  onDevice?: ModelOption[]
  recommended?: DownloadOption[]
}) {
  mocks.options = {
    ready: true,
    catalogLoading: false,
    onDevice,
    detected: onDevice.filter((option) => option.kind === 'scan'),
    library: onDevice.filter((option) => option.kind === 'library'),
    recommended,
    device: { name: 'Apple M2', memoryGb: 16, freeGb: 84 },
    tier: 'unified_16',
    tierReady: true,
    profile: null,
  }
}

const named = (event: string) =>
  vi
    .mocked(posthog.capture)
    .mock.calls.filter(([name]) => name === event)
    .map(([, props]) => props as Record<string, unknown>)

describe('model step', () => {
  const next = vi.fn()
  const handOff = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useOnboardingStore.getState().begin('full', 'model')
  })

  it('describes the machine and leads with the best fit', () => {
    withOptions({})
    render(<ModelStep next={next} handOff={handOff} />)

    expect(screen.getByText('Apple M2')).toBeInTheDocument()
    expect(
      screen.getByText(
        'onboarding:model.memory 16 · onboarding:model.freeStorage 84'
      )
    ).toBeInTheDocument()
    const best = screen.getByRole('radio', { name: /Qwen3.5 4B/ })
    expect(best).toHaveAttribute('aria-checked', 'true')
    expect(best).toHaveTextContent('onboarding:model.bestFit')
    expect(named('setup_screen_shown')[0]).toMatchObject({
      recommended_count: 1,
      primary_model_id: 'Qwen3.5-4B-Q4_K_M',
    })
  })

  it('starts the download, queues it as the chat model and moves on', () => {
    withOptions({})
    render(<ModelStep next={next} handOff={handOff} />)

    fireEvent.click(screen.getByRole('button', { name: /onboarding:continue/ }))

    expect(mocks.startGguf).toHaveBeenCalledWith(
      catalog,
      expect.objectContaining({ model_id: 'Qwen3.5-4B-Q4_K_M' }),
      undefined,
      expect.objectContaining({ requestOrigin: 'onboarding' })
    )
    expect(useOnboardingStore.getState()).toMatchObject({
      jobs: [{ key: 'chat', taskId: 'Qwen3.5-4B-Q4_K_M', phase: 'running' }],
      choice: { source: 'download', modelId: 'Qwen3.5-4B-Q4_K_M' },
    })
    expect(next).toHaveBeenCalledWith('download')
    expect(named('recommended_model_clicked')[0]).toMatchObject({
      format: 'GGUF',
      position: 0,
    })
  })

  it('asks before downloading a model that will not fit', () => {
    withOptions({ recommended: [download({ fit: 'no', bestFit: false })] })
    render(<ModelStep next={next} handOff={handOff} />)

    fireEvent.click(screen.getByRole('button', { name: /onboarding:continue/ }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(mocks.startGguf).not.toHaveBeenCalled()
    expect(useOnboardingStore.getState().choice).toBeNull()
  })

  it('preselects a model found on disk and imports it on Use', () => {
    withOptions({ onDevice: [found] })
    render(<ModelStep next={next} handOff={handOff} />)

    const row = screen.getByRole('radio', { name: /Llama 3.1 8B/ })
    expect(row).toHaveAttribute('aria-checked', 'true')
    expect(row).toHaveTextContent('onboarding:model.foundIn LM Studio')

    fireEvent.click(
      screen.getByRole('button', { name: /onboarding:model.use Llama 3.1 8B/ })
    )

    expect(mocks.engineImport).toHaveBeenCalledWith('llama.gguf', {
      modelPath: '/lm/llama.gguf',
      mmprojPath: undefined,
      source: 'lmstudio',
    })
    expect(useOnboardingStore.getState().choice).toMatchObject({
      source: 'scan',
      modelId: 'llama.gguf',
    })
    expect(next).toHaveBeenCalledWith('use_model')
    expect(named('setup_local_model_run')[0]).toMatchObject({
      trigger: 'manual',
      scan_source: 'lmstudio',
    })
  })

  it('takes a model already in the library without downloading', () => {
    withOptions({
      onDevice: [
        {
          kind: 'library',
          key: 'library:mlx:qwen',
          title: 'Qwen MLX',
          detail: null,
          iconSrc: null,
          provider: 'mlx',
          modelId: 'Qwen3-4B-4bit',
          matchIds: ['Qwen3-4B-4bit'],
        },
      ],
    })
    render(<ModelStep next={next} handOff={handOff} />)

    fireEvent.click(
      screen.getByRole('button', { name: /onboarding:model.use Qwen MLX/ })
    )

    expect(mocks.startGguf).not.toHaveBeenCalled()
    expect(useOnboardingStore.getState().choice).toMatchObject({
      source: 'library',
      provider: 'mlx',
    })
  })

  it('switches to another row on click', () => {
    withOptions({ onDevice: [found] })
    render(<ModelStep next={next} handOff={handOff} />)

    fireEvent.click(screen.getByRole('radio', { name: /Qwen3.5 4B/ }))

    expect(screen.getByRole('radio', { name: /Qwen3.5 4B/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(
      screen.getByRole('button', { name: /onboarding:continue/ })
    ).toBeInTheDocument()
  })

  it('does not download twice when the user comes back to the step', () => {
    withOptions({})
    useOnboardingStore.getState().choose({
      source: 'download',
      provider: 'llamacpp-upstream',
      modelId: 'Qwen3.5-4B-Q4_K_M',
      title: 'Qwen3.5 4B',
      matchIds: ['Qwen3.5-4B-Q4_K_M'],
    })
    render(<ModelStep next={next} handOff={handOff} />)

    fireEvent.click(screen.getByRole('button', { name: /onboarding:continue/ }))

    expect(mocks.startGguf).not.toHaveBeenCalled()
    expect(useOnboardingStore.getState().jobs).toEqual([])
    expect(next).toHaveBeenCalledWith('continue')
  })

  it('lets the user go on without a model when nothing can be offered', () => {
    withOptions({ recommended: [] })
    render(<ModelStep next={next} handOff={handOff} />)

    expect(
      screen.getByText('onboarding:model.noRecommendations')
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: /onboarding:model.continueWithout/ })
    )
    expect(next).toHaveBeenCalledWith('no_model')
  })
})
