import { useMemo } from 'react'
import { useShallow } from 'zustand/shallow'
import { useHardware } from '@/hooks/useHardware'
import { FALLBACK_HARDWARE_TIER } from '@/constants/models'
import {
  describeHardware,
  isHardwareTier,
  type HardwareProfile,
  type HardwareTier,
} from '@/lib/hardware-tier'

/**
 * Dev-only override (`make dev-onboarding-low-spec`). Read once at module load:
 * it is a compile-time constant, so it cannot change at runtime.
 *
 * `low` and `standard` are the two tiers this flag used to take; they are kept
 * as aliases onto the nearest rung of the new ladder so the existing Makefile
 * target, and anyone's shell history, keep working.
 */
const TIER_ALIASES: Record<string, HardwareTier> = {
  low: 'vram_2',
  standard: 'vram_8',
}

const forcedTier: HardwareTier | null = (() => {
  if (typeof FORCE_HARDWARE_TIER === 'undefined') return null
  const raw = FORCE_HARDWARE_TIER
  if (isHardwareTier(raw)) return raw
  return TIER_ALIASES[raw] ?? null
})()

export type HardwareTierResult = {
  tier: HardwareTier
  /**
   * The measured machine, or `null` when hardware has not been enumerated.
   * Carries the memory budget the fit badge needs, and is NOT synthesised for
   * a forced tier — the override changes which model is offered, not what the
   * machine actually has.
   */
  profile: HardwareProfile | null
  /** False while the enumeration has produced nothing to classify on. */
  ready: boolean
}

/**
 * The machine's rung on the recommendation ladder.
 *
 * Deliberately NOT gated on `hardwareReady`. That flag exists because a stale
 * persisted enumeration must not drive a *backend install* decision; here the
 * decision is only which model to advertise, and RAM/VRAM do not change between
 * launches — so persisted figures are strictly better than none. `ready` is
 * exposed so the caller can hold the picker briefly on a genuinely first
 * launch, where there is no persisted blob to fall back on.
 */
export function useHardwareTier(): HardwareTierResult {
  const { os_type, cpu, total_memory, gpus } = useHardware(
    useShallow((s) => ({
      os_type: s.hardwareData.os_type,
      cpu: s.hardwareData.cpu,
      total_memory: s.hardwareData.total_memory,
      gpus: s.hardwareData.gpus,
    }))
  )

  const profile = useMemo(
    () =>
      describeHardware({
        // A persisted blob written before `os_type` was recorded would otherwise
        // skip the macOS branch and be judged on its (always empty) GPU list.
        os_type: os_type || (IS_MACOS ? 'macos' : ''),
        cpu,
        total_memory,
        gpus,
      }),
    [os_type, cpu, total_memory, gpus]
  )

  return useMemo(() => {
    if (forcedTier) {
      // `ready: true` so the picker does not sit behind its hardware deadline
      // waiting for a detection whose answer is already decided.
      return {
        tier: forcedTier,
        profile: profile ? { ...profile, tier: forcedTier } : null,
        ready: true,
      }
    }
    return {
      tier: profile?.tier ?? FALLBACK_HARDWARE_TIER,
      profile,
      ready: profile !== null,
    }
  }, [profile])
}
