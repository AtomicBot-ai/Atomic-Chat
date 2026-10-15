import { describe, expect, it, vi } from 'vitest'

import {
  loadPrismSetupPlan,
  runPrismSetup,
  verifyPrismDownload,
  type PrismSetupDeps,
} from '../prism-setup'
import { DefaultModelSetupService } from '../default'
import type {
  CompatibilityVerdict,
  PrismCatalog,
  PrismFamiliesResponse,
  PrismSetupPlan,
} from '../types'

const verdict = (
  outcome: CompatibilityVerdict['outcome'],
  provider: string | null = 'atomic-prism'
): CompatibilityVerdict => ({
  outcome,
  provider,
  requires: [],
  evidence: 'rules',
  rules_version: 1,
  reason: 'needs PQ2_0',
})

const plan = (over: Partial<PrismSetupPlan> = {}): PrismSetupPlan => ({
  model_id: 'prism-ml/Bonsai-8B-PQ2_0',
  verdict: verdict('engine_required'),
  engine: {
    version: 'prism-b9100-1234567',
    backend: 'macos-arm64',
    installed: false,
    download_size: 30,
  },
  model: {
    file: 'Bonsai-8B-PQ2_0.gguf',
    url: 'https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/b072e1d/Bonsai-8B-PQ2_0.gguf',
    size: 2_000,
    sha256: 'a'.repeat(64),
  },
  projector: null,
  offers_projector: false,
  total_download_bytes: 2_030,
  free_bytes: null,
  blockers: [],
  ...over,
})

/** Every dependency recording its call in one list, so the order is what is asserted. */
function recordingDeps(over: Partial<PrismSetupDeps> = {}) {
  const calls: string[] = []
  const deps: PrismSetupDeps = {
    installBuild: vi.fn(async (pack, taskId) => {
      calls.push(`install ${pack.version}/${pack.backend} ${taskId}`)
    }),
    activateBuild: vi.fn(async (pack) => {
      calls.push(`activate ${pack.version}/${pack.backend}`)
    }),
    pull: vi.fn(async (p) => {
      calls.push(`pull ${p.model_id}`)
      return 'done' as const
    }),
    check: vi.fn(async (modelId) => {
      calls.push(`check ${modelId}`)
      return verdict('compatible')
    }),
    remove: vi.fn(async (modelId) => {
      calls.push(`remove ${modelId}`)
    }),
    ...over,
  }
  return { calls, deps }
}

describe('runPrismSetup', () => {
  it('installs the build, makes it active, then downloads and checks the model', async () => {
    const { calls, deps } = recordingDeps()

    await expect(runPrismSetup(plan(), deps)).resolves.toEqual({
      outcome: 'ready',
    })
    expect(calls).toEqual([
      'install prism-b9100-1234567/macos-arm64 engine-build-atomic-prism-prism-b9100-1234567',
      'activate prism-b9100-1234567/macos-arm64',
      'pull prism-ml/Bonsai-8B-PQ2_0',
      'check prism-ml/Bonsai-8B-PQ2_0',
    ])
  })

  it('only activates a build that is on disk but not the one in use', async () => {
    const { calls, deps } = recordingDeps()
    const onDisk = plan({
      verdict: verdict('engine_update_required'),
      engine: { ...plan().engine!, installed: true, download_size: 0 },
    })

    await runPrismSetup(onDisk, deps)

    expect(calls).toEqual([
      'activate prism-b9100-1234567/macos-arm64',
      'pull prism-ml/Bonsai-8B-PQ2_0',
      'check prism-ml/Bonsai-8B-PQ2_0',
    ])
  })

  it('touches no engine when PrismML already runs the file', async () => {
    const { calls, deps } = recordingDeps()
    const ready = plan({
      verdict: verdict('compatible'),
      engine: { ...plan().engine!, installed: true, download_size: 0 },
    })

    await runPrismSetup(ready, deps)

    expect(calls).toEqual([
      'pull prism-ml/Bonsai-8B-PQ2_0',
      'check prism-ml/Bonsai-8B-PQ2_0',
    ])
  })

  it('downloads nothing when the core refuses the install, and passes the refusal on', async () => {
    const busy = {
      code: 'ENGINE_INSTALL_IN_PROGRESS',
      message: 'Another install of atomic-prism is running.',
    }
    const { calls, deps } = recordingDeps({
      installBuild: vi.fn(async () => {
        throw busy
      }),
    })

    await expect(runPrismSetup(plan(), deps)).rejects.toBe(busy)
    expect(deps.activateBuild).not.toHaveBeenCalled()
    expect(deps.pull).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('reports each stage as it starts', async () => {
    const { deps } = recordingDeps()
    const stages: string[] = []

    await runPrismSetup(plan(), deps, (stage) => stages.push(stage))

    expect(stages).toEqual([
      'installing_engine',
      'activating_engine',
      'downloading',
      'verifying',
    ])
  })

  it('stops after a download that did not finish: a pause or a refusal is not checked', async () => {
    for (const result of ['paused', 'refused'] as const) {
      const { deps } = recordingDeps({ pull: vi.fn(async () => result) })

      await expect(runPrismSetup(plan(), deps)).resolves.toEqual({
        outcome: result,
      })
      expect(deps.check).not.toHaveBeenCalled()
    }
  })

  it('removes a downloaded file PrismML cannot run and says why', async () => {
    const { calls, deps } = recordingDeps({
      check: vi.fn(async () => ({
        ...verdict('engine_required', 'llamacpp-upstream'),
        reason: 'The header names a packing PrismML does not run.',
      })),
    })

    await expect(runPrismSetup(plan(), deps)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'The header names a packing PrismML does not run.',
    })
    expect(calls.at(-1)).toBe('remove prism-ml/Bonsai-8B-PQ2_0')
  })
})

describe('verifyPrismDownload', () => {
  it('keeps a model PrismML runs', async () => {
    const { deps } = recordingDeps()

    await expect(verifyPrismDownload('m', deps)).resolves.toEqual({
      outcome: 'ready',
    })
    expect(deps.check).toHaveBeenCalledWith('m')
    expect(deps.remove).not.toHaveBeenCalled()
  })
})

describe('verifyPrismDownload when the core cannot be asked', () => {
  it('keeps the model unchecked instead of calling the download a failure', async () => {
    const { deps } = recordingDeps({
      check: vi.fn(async () => {
        throw { code: 'CORE_UNREACHABLE', message: 'No core' }
      }),
    })

    await expect(verifyPrismDownload('m', deps)).resolves.toEqual({
      outcome: 'unchecked',
    })
    expect(deps.remove).not.toHaveBeenCalled()
  })
})

describe('loadPrismSetupPlan', () => {
  it('builds the plan from the verdict, the families, the PrismML catalog and the free space', async () => {
    const families: PrismFamiliesResponse = {
      rules_version: 1,
      families: [
        {
          id: 'bonsai-8b',
          title: 'Bonsai 8B',
          repo: 'prism-ml/Bonsai-8B-gguf',
          revision: 'b072e1d',
          files: [
            {
              file: 'Bonsai-8B-PQ2_0.gguf',
              size: 2_000,
              sha256: 'a'.repeat(64),
              treatment: 'prism_required',
            },
          ],
          projectors: [],
        },
      ],
    }
    const catalog: PrismCatalog = {
      installed: [],
      available: [{ version: 'prism-b9100-1234567', backend: 'macos-arm64' }],
      recommended: 'prism-b9100-1234567/macos-arm64',
      releases: [
        {
          tag: 'prism-b9100-1234567',
          variants: [{ id: 'macos-arm64', size: 30 }],
        },
      ],
    }
    class Service extends DefaultModelSetupService {
      override checkCompatibility = vi.fn(async () =>
        verdict('engine_required')
      )
      override families = vi.fn(async () => families)
      override prismCatalog = vi.fn(async () => catalog)
      override diskAvailable = vi.fn(async () => 1_000_000)
    }
    const service = new Service()

    const loaded = await loadPrismSetupPlan(service, {
      repo: 'prism-ml/Bonsai-8B-gguf',
      file: 'Bonsai-8B-PQ2_0.gguf',
      revision: 'main',
      model_id: 'prism-ml/Bonsai-8B-PQ2_0',
      include_projector: true,
    })

    // The verdict the core's own setup read: the rules and the remote header.
    expect(service.checkCompatibility).toHaveBeenCalledWith({
      repo: 'prism-ml/Bonsai-8B-gguf',
      file: 'Bonsai-8B-PQ2_0.gguf',
      revision: 'main',
      inspect_remote: true,
    })
    expect(loaded).toMatchObject({
      model_id: 'prism-ml/Bonsai-8B-PQ2_0',
      engine: { version: 'prism-b9100-1234567', installed: false },
      total_download_bytes: 2_030,
      free_bytes: 1_000_000,
      blockers: [],
    })
  })

  it('plans without the free space when the core cannot say', async () => {
    class Service extends DefaultModelSetupService {
      override checkCompatibility = vi.fn(async () => verdict('compatible'))
      override families = vi.fn(async () => ({
        rules_version: 1,
        families: [],
      }))
      override prismCatalog = vi.fn(async () => ({
        installed: [],
        available: [],
        recommended: null,
      }))
      override diskAvailable = vi.fn(async () => {
        throw new Error('no such route')
      })
    }

    const loaded = await loadPrismSetupPlan(new Service(), {
      repo: 'o/r',
      file: 'f.gguf',
      model_id: 'o/f',
      include_projector: true,
    })

    expect(loaded.free_bytes).toBeNull()
  })
})
