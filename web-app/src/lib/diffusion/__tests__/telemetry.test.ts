import { beforeEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  events: [] as Array<[string, Record<string, unknown>]>,
}))
vi.mock('@/lib/telemetry-queue', () => ({
  queuedCapture: vi.fn((event: string, props: Record<string, unknown>) => {
    captured.events.push([event, props])
  }),
}))

import {
  captureImageEngineInstall,
  captureImageGalleryAction,
  captureImageGenerate,
  captureVideoGalleryAction,
  captureVideoGenerate,
} from '../telemetry'

describe('diffusion telemetry', () => {
  beforeEach(() => {
    captured.events.length = 0
  })

  it('sends the video generate event with its own numbers and no prompt, seed or path', () => {
    captureVideoGenerate({
      generate_status: 'completed',
      model_family: 'ltx-2',
      quant: 'q4_k_m',
      engine: 'sd-cpp',
      backend: 'metal',
      width: 768,
      height: 512,
      frames: 49,
      fps: 24,
      steps: 8,
      duration_ms: 65_000,
      error_code: null,
    })
    expect(captured.events).toEqual([
      [
        'video_generate',
        {
          generate_status: 'completed',
          model_family: 'ltx-2',
          quant: 'q4_k_m',
          engine: 'sd-cpp',
          backend: 'metal',
          width: 768,
          height: 512,
          frames: 49,
          fps: 24,
          steps: 8,
          duration_ms: 65_000,
          error_code: null,
        },
      ],
    ])
    const keys = Object.keys(captured.events[0][1])
    expect(keys).not.toContain('prompt')
    expect(keys).not.toContain('seed')
    expect(keys).not.toContain('path')
    // The names PostHog has typed for other events are never reused bare.
    expect(keys).not.toContain('status')
  })

  it('sends a gallery action under the video event name', () => {
    captureVideoGalleryAction('save_as')
    captureImageGalleryAction('reveal')
    expect(captured.events).toEqual([
      ['video_gallery_action', { gallery_action: 'save_as' }],
      ['image_gallery_action', { gallery_action: 'reveal' }],
    ])
  })

  it('keeps the image events as they were', () => {
    captureImageGenerate({
      generate_status: 'failed',
      model_family: 'z-image',
      quant: 'q4_k_m',
      engine: 'sd-cpp',
      backend: 'metal',
      width: 1024,
      height: 1024,
      steps: 8,
      batch_size: 2,
      runs: 1,
      duration_ms: null,
      error_code: 'OUT_OF_MEMORY',
    })
    captureImageEngineInstall({
      install_status: 'started',
      backend: 'macos-arm64',
      duration_ms: null,
      error_code: null,
    })
    expect(captured.events.map(([name]) => name)).toEqual([
      'image_generate',
      'image_engine_install',
    ])
    expect(captured.events[0][1]).toMatchObject({ batch_size: 2, runs: 1 })
  })
})
