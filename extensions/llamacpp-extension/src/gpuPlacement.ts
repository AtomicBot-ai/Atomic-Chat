/**
 * Where a model goes when the machine has more than one graphics card.
 *
 * Pure on purpose: it takes the devices llama-server reported and where the
 * other loaded models already sit, and returns the `--device`, `--split-mode`,
 * `--main-gpu` and `--tensor-split` values to use. Nothing here touches a
 * process, so every layout can be tested without a GPU.
 *
 * A copy lives in `llamacpp-extension/src/gpuPlacement.ts`; the two extensions
 * ship as separate packages with no shared runtime module.
 */

export type GpuPlacementMode =
  | 'manual'
  | 'single'
  | 'per_gpu'
  | 'many_small'
  | 'spread'

export type PlacementDevice = {
  id: string
  /** MiB, as `--list-devices` reports it. */
  mem: number
  free: number
}

export type GpuPlan = {
  device: string
  split_mode: string
  main_gpu: number
  tensor_split: string
  /** The device ids this model now occupies, for the next decision. */
  assigned: string[]
}

const isGpu = (device: PlacementDevice) => !/^cpu/i.test(device.id)

/** Most free memory first; ties keep the order llama-server listed them in. */
function byFreeMemory(a: PlacementDevice, b: PlacementDevice) {
  return b.free - a.free
}

function one(device: PlacementDevice): GpuPlan {
  return {
    device: device.id,
    split_mode: 'none',
    main_gpu: 0,
    tensor_split: '',
    assigned: [device.id],
  }
}

/**
 * `assigned` maps each model that is already loaded to the devices it uses.
 * Returns `null` when the placement should be left to the manual settings.
 */
export function planGpuPlacement(input: {
  mode: GpuPlacementMode | string
  devices: PlacementDevice[]
  assigned: Map<string, string[]>
  /** The user's own split, kept when spreading. */
  tensorSplit?: string
}): GpuPlan | null {
  const gpus = input.devices.filter(isGpu)
  if (gpus.length === 0) return null

  const load = (device: PlacementDevice) =>
    [...input.assigned.values()].filter((ids) => ids.includes(device.id)).length

  switch (input.mode) {
    case 'single':
      return one([...gpus].sort(byFreeMemory)[0]!)

    // Fill every card before doubling up on any.
    case 'per_gpu':
      return one(
        [...gpus].sort((a, b) => load(a) - load(b) || byFreeMemory(a, b))[0]!
      )

    // Several small models per card: go where the memory actually is.
    case 'many_small':
      return one(
        [...gpus].sort((a, b) => byFreeMemory(a, b) || load(a) - load(b))[0]!
      )

    case 'spread': {
      if (gpus.length === 1) return one(gpus[0]!)
      const userSplit = input.tensorSplit?.trim()
      // Proportional to what is free now, so a card already holding a model
      // takes a smaller share instead of running out of memory.
      const split =
        userSplit ||
        gpus.map((gpu) => Math.max(1, Math.round(gpu.free / 256))).join(',')
      return {
        device: gpus.map((gpu) => gpu.id).join(','),
        split_mode: 'layer',
        main_gpu: 0,
        tensor_split: split,
        assigned: gpus.map((gpu) => gpu.id),
      }
    }

    default:
      return null
  }
}
