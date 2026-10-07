import { describe, expect, it } from 'vitest'

import {
  buildMediaEngineUpdateOffer,
  MEDIA_ENGINE_PROVIDER,
} from '@/lib/diffusion/engineUpdateOffer'
import type { SdcppManifest } from '@/services/diffusion/install'

const INSTALLED = { tag: 'master-849-d04e895', backendId: 'win-cuda12-x64' }

const manifest = (overrides: Partial<SdcppManifest> = {}): SdcppManifest => ({
  tag_name: 'master-900-abc1234',
  assets: [
    { backend: 'win-cuda12-x64', name: 'sd-win-cuda12-x64.zip', size: 300 },
    {
      backend: 'win-cudart-cu12',
      name: 'cudart-cu12.zip',
      size: 500,
      companion: true,
    },
    { backend: 'macos-arm64', name: 'sd-macos-arm64.zip' },
  ],
  ...overrides,
})

describe('buildMediaEngineUpdateOffer', () => {
  it('moves the installed tag to the manifest one for this host', () => {
    const offer = buildMediaEngineUpdateOffer(
      INSTALLED,
      'win-cuda12-x64',
      manifest()
    )
    expect(offer).toMatchObject({
      provider: MEDIA_ENGINE_PROVIDER,
      currentBackend: 'master-849-d04e895/win-cuda12-x64',
      targetBackend: 'master-900-abc1234/win-cuda12-x64',
      currentVersion: 'master-849-d04e895',
      targetVersion: 'master-900-abc1234',
      restartRequired: false,
    })
  })

  it('counts the companion runtime a new tag downloads again', () => {
    expect(
      buildMediaEngineUpdateOffer(INSTALLED, 'win-cuda12-x64', manifest())
        .downloadSizeBytes
    ).toBe(800)
  })

  it('states no size when the manifest has none for the archive', () => {
    expect(
      buildMediaEngineUpdateOffer(
        { tag: 'master-849-d04e895', backendId: 'macos-arm64' },
        'macos-arm64',
        manifest()
      ).downloadSizeBytes
    ).toBeUndefined()
  })

  it('links the upstream release of an Atomic-built variant', () => {
    expect(
      buildMediaEngineUpdateOffer(
        INSTALLED,
        'win-cuda12-x64',
        manifest({
          tag_name: 'master-900-abc1234-a1b2c3d4',
          upstream_repo: 'AtomicBot-ai/stable-diffusion.cpp',
        })
      ).releaseNotesUrl
    ).toBe(
      'https://github.com/AtomicBot-ai/stable-diffusion.cpp/releases/tag/master-900-abc1234'
    )
  })
})
