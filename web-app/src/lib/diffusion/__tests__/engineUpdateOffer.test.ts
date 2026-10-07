import { describe, expect, it } from 'vitest'

import {
  buildMediaEngineUpdateOffer,
  MEDIA_ENGINE_PROVIDER,
} from '@/lib/diffusion/engineUpdateOffer'
import type { EngineBuildUpdateCheck } from '@/services/engine-builds/types'

const check = (
  overrides: Partial<EngineBuildUpdateCheck> = {}
): EngineBuildUpdateCheck => ({
  update_needed: true,
  current: {
    tag: 'master-849-d04e895',
    backend_id: 'win-cuda12-x64',
    origin: 'downloaded',
  },
  target: {
    tag: 'master-900-abc1234',
    backend_id: 'win-cuda12-x64',
    download_bytes: 800,
  },
  ...overrides,
})

describe('buildMediaEngineUpdateOffer', () => {
  it('moves the active build to the one the core named for this host', () => {
    expect(buildMediaEngineUpdateOffer(check())).toMatchObject({
      provider: MEDIA_ENGINE_PROVIDER,
      currentBackend: 'master-849-d04e895/win-cuda12-x64',
      targetBackend: 'master-900-abc1234/win-cuda12-x64',
      currentVersion: 'master-849-d04e895',
      targetVersion: 'master-900-abc1234',
      restartRequired: false,
    })
  })

  it('states what the core will download, the CUDA runtime included', () => {
    expect(buildMediaEngineUpdateOffer(check())?.downloadSizeBytes).toBe(800)
  })

  it('states no size when the core knows none', () => {
    const target = { ...check().target!, download_bytes: 0 }
    expect(
      buildMediaEngineUpdateOffer(check({ target }))?.downloadSizeBytes
    ).toBeUndefined()
  })

  it('offers nothing when the core says no update is needed', () => {
    expect(
      buildMediaEngineUpdateOffer(check({ update_needed: false }))
    ).toBeNull()
    expect(buildMediaEngineUpdateOffer(check({ target: null }))).toBeNull()
  })

  it('links an upstream build to leejet and a fork build to the fork, by upstream tag', () => {
    expect(buildMediaEngineUpdateOffer(check())?.releaseNotesUrl).toBe(
      'https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-900-abc1234'
    )
    const target = { ...check().target!, tag: 'master-900-abc1234-a1b2c3d4' }
    expect(buildMediaEngineUpdateOffer(check({ target }))?.releaseNotesUrl).toBe(
      'https://github.com/AtomicBot-ai/stable-diffusion.cpp/releases/tag/master-900-abc1234'
    )
  })
})
