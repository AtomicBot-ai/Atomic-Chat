import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { useImageSetting } from '../useImageSetting'
import { useSelectedArtifact, useVideoSetting } from '../useVideoSetting'

describe('useVideoSetting', () => {
  beforeEach(async () => {
    localStorage.clear()
    await useVideoSetting.persist.rehydrate()
    useVideoSetting.setState({
      selectedArtifactId: null,
      advancedOpen: false,
      outputDir: null,
    })
    useImageSetting.setState({ selectedArtifactId: null })
  })

  it('persists under its own key, apart from the image settings', () => {
    useVideoSetting.getState().setSelectedArtifactId('ltx-2:q4_k_m')
    useVideoSetting.getState().setAdvancedOpen(true)
    const stored = JSON.parse(
      localStorage.getItem(localStorageKey.settingVideos) ?? '{}'
    )
    expect(localStorageKey.settingVideos).toBe('setting-videos')
    expect(stored.state).toMatchObject({
      selectedArtifactId: 'ltx-2:q4_k_m',
      advancedOpen: true,
      outputDir: null,
    })
    const images = JSON.parse(
      localStorage.getItem(localStorageKey.settingImages) ?? '{}'
    )
    expect(images.state?.selectedArtifactId ?? null).toBeNull()
  })

  it('stores a blank output folder as null and trims the rest', () => {
    const { setOutputDir } = useVideoSetting.getState()
    setOutputDir('  /Users/me/Movies/Atomic ')
    expect(useVideoSetting.getState().outputDir).toBe('/Users/me/Movies/Atomic')
    setOutputDir('   ')
    expect(useVideoSetting.getState().outputDir).toBeNull()
    setOutputDir(null)
    expect(useVideoSetting.getState().outputDir).toBeNull()
  })

  it('falls back to the defaults for fields a stored state spells wrongly', async () => {
    localStorage.setItem(
      localStorageKey.settingVideos,
      JSON.stringify({
        state: { selectedArtifactId: 7, advancedOpen: 'yes', outputDir: '' },
        version: 0,
      })
    )
    await useVideoSetting.persist.rehydrate()
    expect(useVideoSetting.getState()).toMatchObject({
      selectedArtifactId: null,
      advancedOpen: false,
      outputDir: null,
    })
    localStorage.setItem(
      localStorageKey.settingVideos,
      JSON.stringify({
        state: { selectedArtifactId: 'wan2.2-ti2v-5b:q4_k_m', outputDir: '/v' },
        version: 0,
      })
    )
    await useVideoSetting.persist.rehydrate()
    expect(useVideoSetting.getState()).toMatchObject({
      selectedArtifactId: 'wan2.2-ti2v-5b:q4_k_m',
      advancedOpen: false,
      outputDir: '/v',
    })
  })
})

describe('useSelectedArtifact', () => {
  beforeEach(() => {
    useImageSetting.setState({ selectedArtifactId: 'z-image:q4_k_m' })
    useVideoSetting.setState({ selectedArtifactId: 'ltx-2:q4_k_m' })
  })

  it('reads and writes the selection of the asked-for modality only', () => {
    const image = renderHook(() => useSelectedArtifact('image'))
    const video = renderHook(() => useSelectedArtifact('video'))
    expect(image.result.current.selectedArtifactId).toBe('z-image:q4_k_m')
    expect(video.result.current.selectedArtifactId).toBe('ltx-2:q4_k_m')

    video.result.current.setSelectedArtifactId('wan2.2-ti2v-5b:q4_k_m')
    expect(useVideoSetting.getState().selectedArtifactId).toBe(
      'wan2.2-ti2v-5b:q4_k_m'
    )
    expect(useImageSetting.getState().selectedArtifactId).toBe('z-image:q4_k_m')

    image.result.current.setSelectedArtifactId(null)
    expect(useImageSetting.getState().selectedArtifactId).toBeNull()
    expect(useVideoSetting.getState().selectedArtifactId).toBe(
      'wan2.2-ti2v-5b:q4_k_m'
    )
  })
})
