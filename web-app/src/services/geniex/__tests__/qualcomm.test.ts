import { describe, expect, it, vi } from 'vitest'
import { qualcommSearch } from '../qualcomm'
import { qualcommGeniexCards } from '@/lib/geniex/hub'
import { geniexRows } from '@/lib/managed-engine/hub-feed'

describe('published Qualcomm releases', () => {
  it('offers each versioned QAIRT ZIP for this chip and reuses metadata across queries', async () => {
    const base =
      'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/smollm/releases/v0.66.0/'
    const chip = 'qualcomm-snapdragon-x-elite'
    const runtime = 'RUNTIME_GENIEX_QAIRT'
    const asset = {
      runtime,
      chipset: chip,
      precision: 'PRECISION_W4A16',
      download_url: base + 'small.zip',
    }
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url)
      if (path.includes('pypi.org')) return Response.json({ info: { version: '0.66.0' } })
      if (path.endsWith('manifest.json'))
        return Response.json({
          version: '0.66.0',
          models: [
            {
              id: 'smollm_restricted',
              display_name: 'Restricted SmolLM',
              supported_runtimes: [runtime],
              supported_chipsets: [chip],
              use_case: 'MODEL_USE_CASE_TEXT_GENERATION',
            },
            {
              id: 'smollm',
              display_name: 'SmolLM',
              manifest_urls: { release_assets: base + 'release-assets.json' },
              supported_runtimes: [runtime],
              supported_chipsets: [chip],
              use_case: 'MODEL_USE_CASE_TEXT_GENERATION',
            },
          ],
        })
      if (path.endsWith('release-assets.json'))
        return Response.json({
          model_id: 'smollm',
          aihm_version: '0.66.0',
          assets: [
            asset,
            { ...asset, precision: 'PRECISION_W8A16', download_url: base + 'large.zip' },
            { ...asset, chipset: 'qualcomm-snapdragon-x2-elite' },
            { ...asset, runtime: 'RUNTIME_GENIE' },
            {
              ...asset,
              runtime: 'RUNTIME_GENIEX_LLAMACPP',
              download_url: 'https://huggingface.co/publisher/model/resolve/main/weights.gguf',
            },
            { ...asset, download_url: 'https://example.com/wrong.zip' },
          ],
        })
      expect(init?.method).toBe('HEAD')
      expect([base + 'small.zip', base + 'large.zip']).toContain(path)
      return new Response(null, {
        headers: {
          'content-length': '123',
          'x-amz-version-id': 'version',
          'x-amz-checksum-type': 'FULL_OBJECT',
          'x-amz-checksum-crc64nvme': 'IgcYI0cJzZc=',
        },
      })
    })
    const search = qualcommSearch(request)
    const found = await search('smollm', 'x-elite')
    expect(found.unavailable).toBe(false)
    const cards = found.models.flatMap(qualcommGeniexCards)
    expect(
      geniexRows({ bundles: cards, curated: [], huggingFace: [], query: 'smollm', chip: 'x-elite' })
    ).toHaveLength(2)
    expect(found.models[0]?.variants[0]?.bundle).toEqual({
      size: 123,
      crc64: '220718234709cd97',
      url: base + 'small.zip?versionId=version',
    })
    expect((await search('smollm', 'x2-elite')).models).toEqual([])
    expect(
      (
        await search(
          'smollm',
          'x-elite',
          new Set([base.replace('/v0.66.0/', '/v0.65.0/') + 'small.zip'])
        )
      ).models[0]?.variants
    ).toHaveLength(1)
    expect(request.mock.calls.some(([url]) => String(url).includes('huggingface.co'))).toBe(false)
    expect(request).toHaveBeenCalledTimes(5)
  })
})
