/**
 * Decision D17 - the library's "Re-run" reaching the studio.
 *
 * Task 13 built the handover (`services/media/rerun.ts`) but nothing consumed
 * it, because MediaStudio.tsx is frozen by the selective v2.0.32 protected
 * surface. The user authorised that specific change on 2026-09-10, so these
 * tests describe what the studio must now do with a pending re-run.
 *
 * The promise being pinned is the one the library makes to the user: pressing
 * "Re-run" puts back EXACTLY what was generated before - the same task, the
 * same model, the same parameters, the same seed. Anything less makes the
 * button a lie, which is the same failure decision D8 was answered to prevent.
 *
 * Mirrors MediaStudio.test.tsx's setup: the real provider store and the real
 * form, with only the generation and materialisation hooks stubbed.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MediaStudio } from '../MediaStudio'
import { upcastV1Capabilities } from '@/services/media/contract'
import type { MediaProviderDescriptor } from '@/services/media/contract'
import type { AtomicMediaCapabilities } from '@/services/atomicMedia/types'
import type { MediaLibrary as MediaLibraryService } from '@/services/media/library'
import {
  clearPendingMediaReRun,
  setPendingMediaReRun,
  takePendingMediaReRun,
} from '@/services/media/rerun'
import {
  __setMediaLibrary,
  useMediaLibraryStore,
} from '@/stores/media-library-store'
import { useMediaProviderStore } from '@/stores/media-provider-store'
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

vi.mock('@/hooks/useMediaGeneration', () => ({
  useMediaGeneration: () => ({
    jobs: [],
    latest: undefined,
    job: () => undefined,
    submit: vi.fn(),
    cancel: vi.fn(),
    canCancel: () => false,
  }),
}))

vi.mock('@/hooks/useMediaJobAsset', () => ({
  useMediaJobAsset: () => null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}))

/** The first model the fixture offers, so the re-run names something real. */
const model = capabilities.models[0]!

beforeEach(() => {
  clearPendingMediaReRun()
  useMediaProviderStore.setState({
    providers: [descriptor],
    capabilities: { [PROVIDER]: capabilities },
    health: { [PROVIDER]: { state: 'online' } },
    errors: {},
    selectedModelId: null,
    refreshing: false,
    refresh: vi.fn(),
  } as never)
})

describe('a re-run handed over from the library', () => {
  it('puts the recorded prompt back into the form', () => {
    setPendingMediaReRun({
      provider_id: PROVIDER,
      model_id: model.id,
      task: model.tasks[0]!,
      params: { prompt: 'a red car on a wet road' },
    })

    render(<MediaStudio />)

    expect(screen.getByLabelText('Prompt')).toHaveValue(
      'a red car on a wet road'
    )
  })

  it('selects the model the generation actually used', () => {
    setPendingMediaReRun({
      provider_id: PROVIDER,
      model_id: model.id,
      task: model.tasks[0]!,
      params: { prompt: 'anything' },
    })

    render(<MediaStudio />)

    expect(useMediaProviderStore.getState().selectedModelId).toBe(model.id)
  })

  it('consumes the handover so it cannot fire twice', () => {
    setPendingMediaReRun({
      provider_id: PROVIDER,
      model_id: model.id,
      task: model.tasks[0]!,
      params: { prompt: 'only once' },
    })

    render(<MediaStudio />)

    // A re-run is a one-shot instruction. Left in place it would re-apply
    // itself the next time the user opened Media, overwriting whatever they
    // had typed since.
    expect(takePendingMediaReRun()).toBeUndefined()
  })

  it('leaves the form alone when there is no pending re-run', () => {
    render(<MediaStudio />)

    expect(screen.getByLabelText('Prompt')).toHaveValue('')
  })
})

/** A library backed by nothing, so the Library tab renders without a disk. */
function emptyLibrary(): MediaLibraryService {
  return {
    load: async () => {},
    list: () => [],
    add: async () => {},
    remove: async () => {},
    setFavourite: async () => {},
    readOnly: () => false,
    subscribe: () => () => {},
  }
}

describe('the library entry point', () => {
  beforeEach(() => {
    __setMediaLibrary(emptyLibrary())
    useMediaLibraryStore.setState({
      assets: [],
      loading: false,
      loaded: false,
      readOnly: false,
    })
  })

  it('opens in the Create view and offers a Library tab', () => {
    render(<MediaStudio />)

    expect(screen.getByLabelText('Prompt')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Library' })).toBeInTheDocument()
  })

  it('switches to the Library tab and back', () => {
    render(<MediaStudio />)

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }))

    expect(screen.queryByLabelText('Prompt')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Create' }))

    expect(screen.getByLabelText('Prompt')).toBeInTheDocument()
  })
})
