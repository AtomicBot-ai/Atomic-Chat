/**
 * What the old first-run screen's suite proved about the model choice that the
 * model step still has to: impressions as the funnel counts them, a pick
 * started the way the offer is, the won't-fit question, and a model found on
 * disk that fails to import.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'
import { toast } from 'sonner'

import type { LocalModelCandidate } from '@/services/models/localScan'
import type { CatalogModel, ModelQuant } from '@/services/models/types'
import { useOnboardingStore } from '@/stores/onboarding-store'

import type { DownloadOption, ModelOption } from '../useModelOptions'

const mocks = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  startGguf: vi.fn(() => 'Qwen3.5-4B-Q4_K_M'),
  startMlx: vi.fn(async () => true),
  importBackground: vi.fn(),
  engine: { import: vi.fn() } as { import: ReturnType<typeof vi.fn> } | null,
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@janhq/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EngineManager: { instance: () => ({ get: () => mocks.engine }) },
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

const gguf = (repo: string): CatalogModel =>
  ({ model_name: repo, developer: repo.split('/')[0] }) as CatalogModel

const download = (
  title: string,
  id: string,
  overrides: Partial<DownloadOption> = {}
): DownloadOption => ({
  kind: 'download',
  key: `download:${id}`,
  title,
  detail: null,
  iconSrc: null,
  catalog: gguf(`AtomicChat/${id}-GGUF`),
  variant: { model_id: `${id}-Q4_K_M`, path: `${id}.gguf` } as ModelQuant,
  isMlx: false,
  taskId: `${id}-Q4_K_M`,
  provider: 'llamacpp-upstream',
  matchIds: [`${id}-Q4_K_M`],
  sizeLabel: '2.5 GB',
  sizeBytes: 2.5 * 1024 ** 3,
  fit: 'ok',
  bestFit: false,
  position: 0,
  ...overrides,
})

const qwen = download('Qwen3.5 4B', 'Qwen3.5-4B', { bestFit: true })
const gemma = download('Gemma 4 12B', 'gemma-4-12B-it', {
  sizeLabel: '7.3 GB',
  sizeBytes: 7.3 * 1024 ** 3,
  position: 1,
})

/** A model another app left on disk; each test uses its own path. */
const found = (path: string): Extract<ModelOption, { kind: 'scan' }> => ({
  kind: 'scan',
  key: `scan:${path}`,
  title: 'Llama 3.1 8B',
  detail: 'lmstudio',
  iconSrc: null,
  provider: 'llamacpp-upstream',
  matchIds: [path],
  candidate: {
    id: path,
    displayName: 'Llama 3.1 8B',
    path,
    format: 'gguf',
    source: 'lmstudio',
    runnable: true,
  } as LocalModelCandidate,
})

function withOptions({
  ready = true,
  catalogLoading = false,
  onDevice = [],
  recommended = [qwen, gemma],
}: {
  ready?: boolean
  catalogLoading?: boolean
  onDevice?: ModelOption[]
  recommended?: DownloadOption[]
}) {
  mocks.options = {
    ready,
    catalogLoading,
    onDevice,
    detected: onDevice.filter((option) => option.kind === 'scan'),
    library: onDevice.filter((option) => option.kind === 'library'),
    recommended,
    device: { name: null, memoryGb: null, freeGb: null },
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

describe('model step, as the old setup screen proved it', () => {
  const next = vi.fn()
  const goTo = vi.fn()
  const handOff = vi.fn()
  const renderStep = () =>
    render(<ModelStep next={next} goTo={goTo} handOff={handOff} />)

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.engine = { import: vi.fn(async () => undefined) }
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useOnboardingStore.getState().begin('full', 'model')
  })

  describe('impressions', () => {
    it('reports every offered row once, in the order painted', () => {
      withOptions({})
      const { rerender } = renderStep()

      expect(
        named('recommended_model_shown').map((props) => [
          props.model_id,
          props.position,
          props.section,
        ])
      ).toEqual([
        ['Qwen3.5-4B-Q4_K_M', 0, 'pending'],
        ['gemma-4-12B-it-Q4_K_M', 1, 'pending'],
      ])

      // Painting the same list again is not a new impression.
      withOptions({})
      rerender(<ModelStep next={next} goTo={goTo} handOff={handOff} />)
      expect(named('recommended_model_shown')).toHaveLength(2)
    })

    it('reports a row that arrives after the first paint, and only that one', () => {
      withOptions({ recommended: [qwen] })
      const { rerender } = renderStep()
      vi.mocked(posthog.capture).mockClear()

      withOptions({})
      rerender(<ModelStep next={next} goTo={goTo} handOff={handOff} />)

      expect(
        named('recommended_model_shown').map((props) => props.model_id)
      ).toEqual(['gemma-4-12B-it-Q4_K_M'])
      // The screen itself was reported once, on the first settled paint.
      expect(named('setup_screen_shown')).toEqual([])
    })

    it('reports nothing while the list is still settling', () => {
      // Rows behind the loading line were not seen, so they get no
      // impression for a click to divide by.
      withOptions({ ready: false })
      renderStep()

      expect(screen.getByRole('status')).toHaveTextContent('common:loading')
      expect(named('setup_screen_shown')).toEqual([])
      expect(named('recommended_model_shown')).toEqual([])
    })

    it('waits for the catalog before reporting an empty screen', () => {
      withOptions({ recommended: [], catalogLoading: true })
      const { rerender } = renderStep()
      expect(named('setup_screen_shown')).toEqual([])

      withOptions({ recommended: [qwen] })
      rerender(<ModelStep next={next} goTo={goTo} handOff={handOff} />)

      expect(named('setup_screen_shown')).toEqual([
        expect.objectContaining({ recommended_count: 1 }),
      ])
    })
  })

  describe('each offer', () => {
    it('says its size and how it fits, and marks a model that will not load', () => {
      withOptions({
        recommended: [qwen, { ...gemma, fit: 'no' }],
      })
      renderStep()

      expect(
        screen.getByText('onboarding:model.size 2.5 GB · setup:recommend.fitOk')
      ).not.toHaveClass('ob-warn-text')
      expect(
        screen.getByText('onboarding:model.size 7.3 GB · setup:recommend.fitNo')
      ).toHaveClass('ob-warn-text')
    })

    it('starts a pick the way it starts the offer, under its own position', () => {
      withOptions({})
      renderStep()

      fireEvent.click(screen.getByRole('radio', { name: /Gemma 4 12B/ }))
      fireEvent.click(
        screen.getByRole('button', { name: /onboarding:continue/ })
      )

      expect(mocks.startGguf.mock.calls[0][1]).toMatchObject({
        model_id: 'gemma-4-12B-it-Q4_K_M',
      })
      expect(useOnboardingStore.getState()).toMatchObject({
        jobs: [{ key: 'chat', taskId: 'gemma-4-12B-it-Q4_K_M' }],
        choice: { source: 'download', title: 'Gemma 4 12B' },
      })
      // The index its impression carried, so clicks divide by impressions.
      expect(named('recommended_model_clicked')).toEqual([
        expect.objectContaining({
          model_id: 'gemma-4-12B-it-Q4_K_M',
          position: 1,
        }),
      ])
      expect(next).toHaveBeenCalledWith('download')
    })
  })

  describe("a download that won't fit", () => {
    const red = { ...qwen, fit: 'no' as const }

    it('starts once the user says so anyway', async () => {
      withOptions({ recommended: [red] })
      renderStep()
      fireEvent.click(
        screen.getByRole('button', { name: /onboarding:continue/ })
      )

      fireEvent.click(
        screen.getByRole('button', { name: 'setup:wontFitDialog.confirm' })
      )

      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      )
      expect(mocks.startGguf.mock.calls[0][1]).toMatchObject({
        model_id: 'Qwen3.5-4B-Q4_K_M',
      })
      expect(useOnboardingStore.getState().choice).toMatchObject({
        source: 'download',
        modelId: 'Qwen3.5-4B-Q4_K_M',
      })
      expect(next).toHaveBeenCalledWith('download')
    })

    it('leaves everything as it was when the user cancels', async () => {
      withOptions({ recommended: [red] })
      renderStep()
      fireEvent.click(
        screen.getByRole('button', { name: /onboarding:continue/ })
      )

      fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))

      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      )
      expect(mocks.startGguf).not.toHaveBeenCalled()
      expect(useOnboardingStore.getState()).toMatchObject({
        choice: null,
        jobs: [],
      })
      expect(next).not.toHaveBeenCalled()
    })

    it('does not ask about a model that might fit: it runs, only tighter', () => {
      withOptions({ recommended: [{ ...qwen, fit: 'warn' }] })
      renderStep()

      fireEvent.click(
        screen.getByRole('button', { name: /onboarding:continue/ })
      )

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(useOnboardingStore.getState().jobs).toEqual([
        expect.objectContaining({ key: 'chat', phase: 'running' }),
      ])
    })
  })

  describe('a model found on disk', () => {
    it('says so and forgets the choice when its import fails, and imports it again on the next try', async () => {
      const llama = found('/lm/failing.gguf')
      withOptions({ onDevice: [llama] })
      mocks.engine!.import.mockRejectedValueOnce(new Error('unsupported'))
      renderStep()
      const use = screen.getByRole('button', {
        name: /onboarding:model.use Llama 3.1 8B/,
      })

      await act(async () => {
        fireEvent.click(use)
      })

      expect(toast.error).toHaveBeenCalledWith('setup:localStep.importFailed')
      expect(useOnboardingStore.getState().choice).toBeNull()

      // Back on the step, the same file is offered and taken again.
      await act(async () => {
        fireEvent.click(use)
      })
      expect(mocks.engine!.import.mock.calls.map(([id]) => id)).toEqual([
        '/lm/failing.gguf',
        '/lm/failing.gguf',
      ])
      expect(useOnboardingStore.getState().choice).toMatchObject({
        source: 'scan',
        modelId: '/lm/failing.gguf',
      })
    })

    it('stays on the step when no engine can take the file', () => {
      mocks.engine = null
      withOptions({ onDevice: [found('/lm/orphan.gguf')] })
      renderStep()

      fireEvent.click(
        screen.getByRole('button', { name: /onboarding:model.use Llama/ })
      )

      expect(toast.error).toHaveBeenCalledWith('setup:localStep.importFailed')
      expect(useOnboardingStore.getState().choice).toBeNull()
      expect(next).not.toHaveBeenCalled()
    })

    it('adds the others to the library on the way out, not the one already taken', () => {
      const taken = found('/lm/taken.gguf')
      const other = found('/lm/other.gguf')
      withOptions({ onDevice: [taken, other] })
      const { unmount } = renderStep()

      fireEvent.click(
        screen.getByRole('button', { name: /onboarding:model.use Llama/ })
      )
      unmount()

      expect(
        mocks.importBackground.mock.calls[0][0].map(
          (candidate: LocalModelCandidate) => candidate.path
        )
      ).toEqual(['/lm/other.gguf'])
    })
  })
})
