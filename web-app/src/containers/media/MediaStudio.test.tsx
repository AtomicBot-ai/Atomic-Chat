/**
 * The Media Studio, end to end over the real provider store.
 *
 * Before Task 11 this file mocked `useAtomicMediaJob` and asserted the v1 body
 * the form submitted. That hook is gone: the job now lives in the module-scoped
 * job manager and providers come from the provider store, so the test seeds the
 * REAL store and lets the real form, preview and status components render.
 *
 * Only two things are stubbed, and neither is the subject:
 *  - `useMediaGeneration`, so a job can be put into any state without a
 *    provider on the other end of a socket.
 *  - `useMediaJobAsset`, because materialising needs a filesystem. It has its
 *    own seven tests; what matters here is that the Studio hands what it
 *    returns to the preview.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MediaStudio } from './MediaStudio'
import { useMediaProviderStore } from '@/stores/media-provider-store'
import { upcastV1Capabilities } from '@/services/media/contract'
import type {
  MediaJobSnapshot,
  MediaProviderDescriptor,
} from '@/services/media/contract'
import type { MediaAsset } from '@/services/media/assets'
import type { AtomicMediaCapabilities } from '@/services/atomicMedia/types'
import fixture from '@/services/media/contract/__tests__/fixtures/worker-v1-capabilities.json'

const PROVIDER = 'atomic-media-worker'
const capabilities = upcastV1Capabilities(
  fixture.payload as AtomicMediaCapabilities,
  PROVIDER
)

const descriptor: MediaProviderDescriptor = {
  id: PROVIDER,
  label: 'Radium Media Worker',
  kind: 'local_worker',
  adapter: 'atomic-media-worker',
  enabled: true,
  origin: 'builtin',
}

const submit = vi.fn()
const cancel = vi.fn()
const refresh = vi.fn()
let latest: (MediaJobSnapshot & { cancellable: boolean }) | undefined
let asset: MediaAsset | null

vi.mock('@/hooks/useMediaGeneration', () => ({
  useMediaGeneration: () => ({
    jobs: latest ? [latest] : [],
    latest,
    job: () => latest,
    submit,
    cancel,
    canCancel: () => Boolean(latest?.cancellable),
  }),
}))

vi.mock('@/hooks/useMediaJobAsset', () => ({
  useMediaJobAsset: () => asset,
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}))

function seed(overrides: Partial<Parameters<typeof useMediaProviderStore.setState>[0]> = {}) {
  useMediaProviderStore.setState({
    providers: [descriptor],
    capabilities: { [PROVIDER]: capabilities },
    health: { [PROVIDER]: { state: 'online', version: '0.6.1' } },
    errors: {},
    selectedModelId: null,
    refreshing: false,
    refresh,
    ...overrides,
  } as never)
}

beforeEach(() => {
  submit.mockReset()
  cancel.mockReset()
  refresh.mockReset()
  latest = undefined
  asset = null
  seed()
})

describe('MediaStudio', () => {
  it('renders the schema-driven generation controls', () => {
    render(<MediaStudio />)

    expect(
      screen.getByRole('heading', { name: 'Media Studio' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument()
    expect(screen.getByLabelText('Resolution')).toBeInTheDocument()
    expect(screen.getByLabelText('Frames')).toBeInTheDocument()
    expect(screen.getByLabelText('FPS')).toBeInTheDocument()
    expect(screen.getByLabelText('Steps')).toBeInTheDocument()
    expect(screen.getByLabelText('Guidance')).toBeInTheDocument()
    expect(screen.getByLabelText('Negative prompt')).toBeInTheDocument()
    expect(screen.getByLabelText('Device')).toHaveValue('cuda:0')
  })

  it('names the model and the provider it belongs to', () => {
    render(<MediaStudio />)

    expect(
      screen.getByText('Registry Video · Radium Media Worker')
    ).toBeInTheDocument()
  })

  it('offers a tab for every task the provider declares', () => {
    render(<MediaStudio />)

    // Scoped to the task tablist: the studio also has Create/Library tabs now,
    // which are a different concern (Phase 4).
    const taskTabs = within(
      screen.getByRole('tablist', { name: 'Generation task' })
    ).getAllByRole('tab')

    const declared = capabilities.tasks ?? []
    expect(taskTabs).toHaveLength(declared.length)

    // An impl-detail id is not what a person thinks in: the tab reads "Video",
    // not "text_to_video" (Phase 4 friendly labels).
    const labels = taskTabs.map((node) => node.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Video', 'Animate image']))
    expect(labels).not.toContain('text_to_video')
    expect(labels).not.toContain('image_to_video')
  })

  it('submits a request routed to the provider that owns the model', () => {
    render(<MediaStudio />)

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'A red sports car exits a garage' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

    expect(submit).toHaveBeenCalledTimes(1)
    const request = submit.mock.calls[0]?.[0]
    expect(request).toMatchObject({
      provider_id: PROVIDER,
      model_id: `${PROVIDER}:registry-video`,
      task: 'text_to_video',
      device: 'cuda:0',
      params: {
        prompt: 'A red sports car exits a garage',
        resolution: '832x480',
        num_frames: 17,
        fps: 12,
        steps: 10,
        guidance_scale: 5,
      },
    })
  })

  it('corrects the frame count in the field before it is submitted', () => {
    render(<MediaStudio />)

    const frames = screen.getByLabelText('Frames')
    fireEvent.change(frames, { target: { value: '20' } })
    fireEvent.blur(frames)

    // The rule is 4n + 1, so 20 becomes 21 in the field the user sees - not
    // silently fixed up on the way out.
    expect(frames).toHaveValue(21)

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'A careful camera move through fog' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      params: expect.objectContaining({ num_frames: 21 }),
    })
  })

  it('reports each provider by name and retries just that one', () => {
    seed({ health: { [PROVIDER]: { state: 'offline', detail: 'refused' } } })
    render(<MediaStudio />)

    // Scoped to the provider list: the label also appears in the header and in
    // the provider select, and this is about the health row specifically.
    const providerList = screen.getByRole('list')
    expect(
      within(providerList).getByText('Radium Media Worker')
    ).toBeInTheDocument()
    expect(within(providerList).getByText(/Offline/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(refresh).toHaveBeenCalledWith({ providerId: PROVIDER })
  })

  it('shows progress while a job runs', () => {
    latest = {
      client_job_id: 'job-1',
      provider_id: PROVIDER,
      state: 'running',
      progress: 68,
      cancellable: false,
    }
    render(<MediaStudio />)

    expect(screen.getByText('68%')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
  })

  it('offers Cancel only when the provider says it can cancel', () => {
    latest = {
      client_job_id: 'job-1',
      provider_id: PROVIDER,
      state: 'running',
      progress: 10,
      cancellable: true,
    }
    render(<MediaStudio />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // The v1 cancel cleared a local timer and never told the worker (C11).
    expect(cancel).toHaveBeenCalledWith('job-1')
  })

  it('previews the materialised asset, never the provider output path', () => {
    latest = {
      client_job_id: 'job-1',
      provider_id: PROVIDER,
      state: 'succeeded',
      cancellable: false,
    }
    asset = {
      asset_id: 'a1',
      client_job_id: 'job-1',
      media_type: 'video',
      path: 'D:/AtomicMedia/outputs/jobs/job-1.mp4',
      mime: 'video/mp4',
      bytes: 100,
      created_at: 0,
      provenance: {
        provider_id: PROVIDER,
        model_id: `${PROVIDER}:registry-video`,
        model_label: 'Registry Video',
        task: 'text_to_video',
        params: {},
        app_version: 'test',
        contract_version: 2,
      },
    }
    render(<MediaStudio />)

    expect(screen.getByTestId('media-video-preview')).toHaveAttribute(
      'src',
      'asset://D:/AtomicMedia/outputs/jobs/job-1.mp4'
    )
  })

  it('asks every enabled provider for its health on arrival', () => {
    render(<MediaStudio />)

    // Health is never persisted, so a stale "online" can never be shown.
    expect(refresh).toHaveBeenCalled()
  })
})
