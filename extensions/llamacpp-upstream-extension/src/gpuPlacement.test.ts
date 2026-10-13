import { describe, expect, it } from 'vitest'

import { planGpuPlacement, type PlacementDevice } from './gpuPlacement'

const gpus: PlacementDevice[] = [
  { id: 'CUDA0', mem: 24576, free: 20000 },
  { id: 'CUDA1', mem: 12288, free: 12000 },
]
const none = new Map<string, string[]>()

describe('planGpuPlacement', () => {
  it('leaves manual settings alone, and ignores a CPU-only machine', () => {
    expect(planGpuPlacement({ mode: 'manual', devices: gpus, assigned: none })).toBeNull()
    expect(
      planGpuPlacement({ mode: 'single', devices: [{ id: 'CPU', mem: 1, free: 1 }], assigned: none })
    ).toBeNull()
  })

  it('single: the card with the most free memory, no splitting', () => {
    expect(planGpuPlacement({ mode: 'single', devices: gpus, assigned: none })).toMatchObject({
      device: 'CUDA0',
      split_mode: 'none',
      tensor_split: '',
    })
  })

  it('per_gpu: fills every card before doubling up', () => {
    const first = planGpuPlacement({ mode: 'per_gpu', devices: gpus, assigned: none })!
    expect(first.device).toBe('CUDA0')
    const second = planGpuPlacement({
      mode: 'per_gpu',
      devices: gpus,
      assigned: new Map([['m1', first.assigned]]),
    })!
    expect(second.device).toBe('CUDA1')
  })

  it('many_small: goes where the memory is, even to a card already in use', () => {
    const plan = planGpuPlacement({
      mode: 'many_small',
      devices: gpus,
      assigned: new Map([['m1', ['CUDA0']]]),
    })!
    expect(plan.device).toBe('CUDA0')
  })

  it('spread: all cards, layer split, proportional to free memory unless set', () => {
    const plan = planGpuPlacement({ mode: 'spread', devices: gpus, assigned: none })!
    expect(plan).toMatchObject({ device: 'CUDA0,CUDA1', split_mode: 'layer' })
    const [a, b] = plan.tensor_split.split(',').map(Number)
    expect(a).toBeGreaterThan(b!)
    expect(
      planGpuPlacement({ mode: 'spread', devices: gpus, assigned: none, tensorSplit: '1,1' })!
        .tensor_split
    ).toBe('1,1')
  })

  it('spread on one card is just that card', () => {
    expect(
      planGpuPlacement({ mode: 'spread', devices: [gpus[0]!], assigned: none })
    ).toMatchObject({ device: 'CUDA0', split_mode: 'none' })
  })
})
