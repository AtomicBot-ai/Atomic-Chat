import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { seedServiceHub } from '@/test/service-hub'
import { DefaultModelSetupService } from '@/services/model-setup/default'
import type {
  CompatibilityVerdict,
  PrismCatalog,
  PrismFamiliesResponse,
} from '@/services/model-setup/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

import { ModelSetupSheet } from '../ModelSetupSheet'

const file = {
  repo: 'prism-ml/Bonsai-8B-gguf',
  file: 'Bonsai-8B-PQ2_0.gguf',
  revision: 'main',
}

const verdict = (
  outcome: CompatibilityVerdict['outcome'] = 'engine_required'
): CompatibilityVerdict => ({
  outcome,
  provider: 'atomic-prism',
  requires: ['PQ2_0'],
  evidence: 'rules',
  rules_version: 1,
  reason: 'r',
})

const families: PrismFamiliesResponse = {
  rules_version: 1,
  families: [
    {
      id: 'bonsai-8b',
      title: 'Bonsai 8B',
      repo: file.repo,
      revision: 'b072e1d',
      files: [
        {
          file: file.file,
          size: 2_000_000_000,
          sha256: 'a'.repeat(64),
          treatment: 'prism_required',
          default: true,
        },
      ],
      projectors: [
        {
          file: 'mmproj.gguf',
          size: 500_000_000,
          sha256: 'c'.repeat(64),
          default: true,
        },
      ],
    },
  ],
}

const catalog = (over: Partial<PrismCatalog> = {}): PrismCatalog => ({
  installed: [],
  available: [{ version: 'prism-b9000-abcdef0', backend: 'macos-arm64' }],
  recommended: 'prism-b9000-abcdef0/macos-arm64',
  releases: [
    {
      tag: 'prism-b9000-abcdef0',
      variants: [{ id: 'macos-arm64', size: 20_000_000 }],
    },
  ],
  ...over,
})

class FakeService extends DefaultModelSetupService {
  checkCompatibility = vi.fn(async () => verdict())
  families = vi.fn(async () => families)
  prismCatalog = vi.fn(async () => catalog())
  diskAvailable = vi.fn(async () => 100_000_000_000 as number | null)
  override isSupported() {
    return true
  }
}

let service: FakeService
const onStart = vi.fn()

const renderSheet = () =>
  render(
    <ModelSetupSheet
      open
      onOpenChange={() => {}}
      file={file}
      modelName="Bonsai 8B"
      modelId="prism-ml/Bonsai-8B-PQ2_0"
      onStart={onStart}
    />
  )

describe('ModelSetupSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    service = new FakeService()
    seedServiceHub({ modelSetup: service })
  })

  it('shows the engine, the model, the projector and the bytes, from what the core reports', async () => {
    renderSheet()

    expect(await screen.findByTestId('model-setup-engine')).toHaveTextContent(
      'hub:prismSetupEngineDownload'
    )
    expect(screen.getByTestId('model-setup-engine')).toHaveTextContent(
      'prism-b9000-abcdef0'
    )
    expect(screen.getByText(/Bonsai-8B-PQ2_0\.gguf/)).toBeInTheDocument()
    expect(screen.getByText(/mmproj\.gguf/)).toBeInTheDocument()
    expect(screen.getByTestId('model-setup-total')).toHaveTextContent(
      'hub:prismSetupFree'
    )
    // Planned in the app: the verdict, the families, the catalog and the
    // disk, and no setup-plan route of the core.
    expect(service.checkCompatibility).toHaveBeenCalledWith({
      ...file,
      inspect_remote: true,
    })
    expect(service.families).toHaveBeenCalled()
    expect(service.prismCatalog).toHaveBeenCalled()
    expect(service.diskAvailable).toHaveBeenCalled()
  })

  it('shows the plan the row already read without asking the core again', async () => {
    const { loadPrismSetupPlan } = await import(
      '@/services/model-setup/prism-setup'
    )
    const initialPlan = await loadPrismSetupPlan(service, {
      ...file,
      model_id: 'prism-ml/Bonsai-8B-PQ2_0',
      include_projector: true,
    })
    vi.clearAllMocks()
    render(
      <ModelSetupSheet
        open
        onOpenChange={() => {}}
        file={file}
        modelName="Bonsai 8B"
        modelId="prism-ml/Bonsai-8B-PQ2_0"
        initialPlan={initialPlan}
        onStart={onStart}
      />
    )

    expect(await screen.findByTestId('model-setup-engine')).toHaveTextContent(
      'prism-b9000-abcdef0'
    )
    expect(service.prismCatalog).not.toHaveBeenCalled()
    expect(service.checkCompatibility).not.toHaveBeenCalled()
  })

  it('starts the plan it showed, read again just before', async () => {
    renderSheet()
    await screen.findByTestId('model-setup-engine')

    fireEvent.click(screen.getByTestId('model-setup-start'))

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1))
    expect(onStart.mock.calls[0][0]).toMatchObject({
      model_id: 'prism-ml/Bonsai-8B-PQ2_0',
      engine: { version: 'prism-b9000-abcdef0', installed: false },
      projector: { file: 'mmproj.gguf' },
    })
    expect(service.prismCatalog).toHaveBeenCalledTimes(2)
  })

  it('leaves the projector out when image support is turned off', async () => {
    renderSheet()
    fireEvent.click(await screen.findByTestId('model-setup-vision'))

    await waitFor(() => expect(screen.queryByText(/mmproj\.gguf/)).toBeNull())
    fireEvent.click(screen.getByTestId('model-setup-start'))
    await waitFor(() => expect(onStart).toHaveBeenCalled())
    expect(onStart.mock.calls[0][0].projector).toBeNull()
  })

  it('shows a plan that changed instead of starting a different one', async () => {
    renderSheet()
    await screen.findByTestId('model-setup-engine')
    // The build got installed meanwhile: nothing to download for the engine.
    service.prismCatalog.mockResolvedValue(
      catalog({
        installed: [{ version: 'prism-b9000-abcdef0', backend: 'macos-arm64' }],
      })
    )

    fireEvent.click(screen.getByTestId('model-setup-start'))

    expect(
      await screen.findByText('hub:prismSetupPlanChanged')
    ).toBeInTheDocument()
    expect(screen.getByTestId('model-setup-engine')).toHaveTextContent(
      'hub:prismSetupEngineInstalled'
    )
    expect(onStart).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('model-setup-start'))
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1))
  })

  it('cannot start a plan with blockers and says why', async () => {
    service.diskAvailable.mockResolvedValue(1_000)
    service.checkCompatibility.mockResolvedValue({
      ...verdict('engine_update_required'),
      min_prism_build: 9999,
    })
    renderSheet()

    expect(
      await screen.findByText('hub:prismBlocker_no_engine_build')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/hub:prismBlocker_insufficient_disk_space/)
    ).toBeInTheDocument()
    expect(screen.getByTestId('model-setup-engine')).toHaveTextContent(
      'hub:prismSetupEngineNone'
    )
    expect(screen.getByTestId('model-setup-start')).toBeDisabled()
  })

  it('names the replacement of a file in an old layout', async () => {
    service.checkCompatibility.mockResolvedValue({
      ...verdict('legacy_artifact'),
      reason: 'An old layout.',
      replacement: 'Bonsai-8B-PQ2_0-v2.gguf',
    })
    renderSheet()

    expect(await screen.findByText(/An old layout\./)).toHaveTextContent(
      'hub:prismSetupReplacement'
    )
    expect(screen.getByTestId('model-setup-start')).toBeDisabled()
  })

  it('says a newer engine is coming next to the current one', async () => {
    service.checkCompatibility.mockResolvedValue({
      ...verdict('engine_update_required'),
      min_prism_build: 9000,
    })
    renderSheet()

    expect(
      await screen.findByTestId('model-setup-engine-update')
    ).toHaveTextContent('hub:prismEngineUpdateRequired')
  })

  it('says what failed when the core cannot be asked', async () => {
    service.prismCatalog.mockRejectedValue({
      code: 'CORE_UNREACHABLE',
      message: 'No core',
    })
    renderSheet()

    expect(await screen.findByRole('alert')).toHaveTextContent('No core')
    expect(screen.getByTestId('model-setup-start')).toBeDisabled()
  })
})
