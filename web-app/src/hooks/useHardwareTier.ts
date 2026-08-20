import { useMemo } from 'react'
import { useShallow } from 'zustand/shallow'
import { useHardware } from '@/hooks/useHardware'
import {
  classifyHardwareTier,
  type HardwareTier,
} from '@/lib/hardware-tier'

/**
 * The machine's tier for onboarding's model recommendations.
 *
 * Deliberately NOT gated on `hardwareReady`. That flag exists because a stale
 * persisted enumeration must not drive a *backend install* decision; here the
 * decision is only which two models to advertise, and RAM/VRAM do not change
 * between launches — so persisted figures are strictly better than none.
 * `ready` is exposed so the caller can hold the picker briefly on a genuinely
 * first launch, where there is no persisted blob to fall back on.
 */
/// Dev-only override (`make dev-onboarding-low-spec`). Read once at module
/// load: it is a compile-time constant, so it cannot change at runtime.
const forcedTier: HardwareTier | null =
  typeof FORCE_HARDWARE_TIER !== 'undefined' &&
  (FORCE_HARDWARE_TIER === 'low' || FORCE_HARDWARE_TIER === 'standard')
    ? FORCE_HARDWARE_TIER
    : null

export function useHardwareTier(): { tier: HardwareTier; ready: boolean } {
  const { os_type, cpu, total_memory, gpus } = useHardware(
    useShallow((s) => ({
      os_type: s.hardwareData.os_type,
      cpu: s.hardwareData.cpu,
      total_memory: s.hardwareData.total_memory,
      gpus: s.hardwareData.gpus,
    }))
  )

  const tier = useMemo(
    () =>
      classifyHardwareTier({
        // A persisted blob written before `os_type` was recorded would otherwise
        // skip the macOS branch and be judged on its (always empty) GPU list.
        os_type: os_type || (IS_MACOS ? 'macos' : ''),
        cpu,
        total_memory,
        gpus,
      }),
    [os_type, cpu, total_memory, gpus]
  )

  // `ready: true` so the picker does not sit behind its hardware deadline
  // waiting for a detection whose answer is already decided.
  if (forcedTier) return { tier: forcedTier, ready: true }

  return { tier: tier ?? 'standard', ready: tier !== null }
}
