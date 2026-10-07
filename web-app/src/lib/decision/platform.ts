import { isArmArch } from '@/lib/hardware-tier'
import type { DecisionEngine } from '@/services/decision-catalog-registry'

/**
 * Whether an engine that runs decision models ships a build for this desktop.
 * TurboQuant (`llamacpp`): macOS on Apple silicon, Windows and Linux on x64;
 * there is no fork build for macOS x64, Windows arm64 or Linux arm64. Stock
 * llama.cpp (`llamacpp-upstream`): the builds the conf mirror carries, macOS
 * on Apple silicon, Windows on x64 and arm64, Linux on x64. An arch not
 * reported yet counts as supported, so the page does not flicker away while
 * the hardware facts load.
 */
export function isDecisionHostSupported(
  arch: string | undefined,
  engine: DecisionEngine = 'llamacpp'
): boolean {
  if (!arch) return true
  const arm = isArmArch(arch)
  if (IS_MACOS) return arm
  if (IS_WINDOWS) return engine === 'llamacpp-upstream' || !arm
  if (IS_LINUX) return !arm
  return false
}

/** Whether any decision engine runs here: the Hub's Decision category shows then. */
export function isAnyDecisionHostSupported(arch: string | undefined): boolean {
  return (
    isDecisionHostSupported(arch, 'llamacpp') ||
    isDecisionHostSupported(arch, 'llamacpp-upstream')
  )
}
