import { describe, expect, it } from 'vitest'

import { diffusionPathsFor, joinDiffusionPath, VIDEOS_DIR } from '../config'

describe('diffusionPathsFor', () => {
  it("puts the video gallery beside the image gallery, with the data folder's own separator", () => {
    expect(VIDEOS_DIR).toBe('videos')
    expect(diffusionPathsFor('/Users/me/data')).toEqual({
      dataFolder: '/Users/me/data',
      modelsRoot: '/Users/me/data/diffusion/models',
      backendsRoot: '/Users/me/data/diffusion/backends',
      imagesDir: '/Users/me/data/images',
      videosDir: '/Users/me/data/videos',
    })
    expect(diffusionPathsFor('C:\\Users\\me\\data').videosDir).toBe(
      'C:\\Users\\me\\data\\videos'
    )
    expect(joinDiffusionPath('/data', 'videos', 'a/b.webm')).toBe(
      '/data/videos/a/b.webm'
    )
  })
})
