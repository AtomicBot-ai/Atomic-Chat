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
  mediaTargetProps,
  videoEstimateProps,
} from '../telemetry'
import { useProviderRegistryStore } from '@/stores/provider-registry-store'

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
      estimate_verdict: 'fits',
      estimate_low_s: 300,
      estimate_high_s: 600,
      estimate_basis: 'heuristic',
      slowdown_seen: false,
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
          estimate_verdict: 'fits',
          estimate_low_s: 300,
          estimate_high_s: 600,
          estimate_basis: 'heuristic',
          slowdown_seen: false,
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

  it('reads the estimate fields off a job: none without an estimate, no range when it exceeds', () => {
    expect(videoEstimateProps({ progress: null })).toEqual({
      estimate_verdict: 'none',
      estimate_low_s: null,
      estimate_high_s: null,
      estimate_basis: null,
      slowdown_seen: false,
    })
    expect(
      videoEstimateProps({
        estimate: {
          memory: {
            requiredBytes: 2,
            budgetBytes: 1,
            pool: 'unified',
            verdict: 'exceeds',
          },
          seconds: null,
          basis: 'history',
        },
        progress: { slowdown: true },
      })
    ).toEqual({
      estimate_verdict: 'exceeds',
      estimate_low_s: null,
      estimate_high_s: null,
      estimate_basis: 'history',
      slowdown_seen: true,
    })
  })

  it('sends a gallery action under the video event name', () => {
    captureVideoGalleryAction('save_as')
    captureImageGalleryAction('reveal')
    expect(captured.events).toEqual([
      ['video_gallery_action', { gallery_action: 'save_as' }],
      ['image_gallery_action', { gallery_action: 'reveal' }],
    ])
  })

  it("names where a run went, and never a provider name the user chose", () => {
    useProviderRegistryStore.setState({
      providers: [{ provider: 'openai' }] as never,
    })
    expect(mediaTargetProps(undefined)).toEqual({ media_target: 'local', media_provider: null })
    expect(mediaTargetProps({ provider: 'openai', model: 'gpt-image-2' })).toEqual({
      media_target: 'remote',
      media_provider: 'openai',
    })
    expect(mediaTargetProps({ provider: 'automatic1111', model: 'sdxl' })).toEqual({
      media_target: 'remote',
      media_provider: 'automatic1111',
    })
    expect(mediaTargetProps({ provider: 'Acme render farm', model: 'x' })).toEqual({
      media_target: 'remote',
      media_provider: 'custom',
    })

    captureImageGenerate({
      generate_status: 'completed',
      model_family: null,
      quant: null,
      engine: null,
      backend: null,
      width: 1024,
      height: 1024,
      steps: 0,
      batch_size: 1,
      runs: 1,
      duration_ms: 4_000,
      error_code: null,
      ...mediaTargetProps({ provider: 'openai', model: 'gpt-image-2' }),
    })
    expect(captured.events[0][1]).toMatchObject({
      media_target: 'remote',
      media_provider: 'openai',
    })
    expect(JSON.stringify(captured.events)).not.toContain('gpt-image-2')
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
