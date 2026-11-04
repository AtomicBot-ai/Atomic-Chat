/** Small, hermetic HF trees for component tests which review a model installation. */
import { vi } from 'vitest'
import type { PrismFamiliesResponse } from '@/services/model-setup/types'

export function mockHfModelMetadata(families: PrismFamiliesResponse['families']) {
  const request = vi.fn(async (input: RequestInfo | URL) => {
    const match = /\/api\/models\/(.+)\/revision\/([^?]+)/.exec(String(input))
    const family = families.find(family => family.repo === match?.[1])
    if (!match || !family) return new Response(null, { status: 404 })
    return Response.json({ sha: /^[0-9a-f]{40}$/.test(match[2]) ? match[2] : 'a'.repeat(40),
      siblings: [...family.files, ...family.projectors].map(file => ({ rfilename: file.file, lfs: { size: file.size, sha256: file.sha256 } })),
    })
  })
  vi.stubGlobal('fetch', request)
  return request
}
