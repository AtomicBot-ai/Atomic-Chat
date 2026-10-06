/**
 * Whether a managed engine's provider belongs in this app's lists at all (spec
 * `tensorrt-llm-desktop`, "Провайдер виден там, где может работать или может быть настроен"; the
 * same rule for every managed engine, by that engine's own plan, spec `vllm-desktop`).
 *
 * The spec hides it where there is no NVIDIA card and where the core has no descriptor for the
 * engine. The core describes both as blockers of a `prerequisite-blocked` plan, not as
 * `unsupported`: without `nvidia-smi` it cannot tell "no driver" from "no card", so both hide it,
 * and every other blocker stays visible with its instructions (ruling R-app-5).
 */

/** The reasons, among a plan's blockers, that mean this machine is not an NVIDIA one or has no descriptor. */
const HIDING_REASONS = new Set(['driver-missing', 'no-gpu', 'descriptor-unavailable'])

export interface PlanVerdict {
  availability: string
  blockers: Array<{ reason?: string }>
}

export function isProviderHidden(plan: PlanVerdict): boolean {
  if (plan.availability === 'unsupported') return true
  return plan.blockers.some((blocker) => blocker.reason !== undefined && HIDING_REASONS.has(blocker.reason))
}

export interface EnvironmentView {
  installations: Array<{ engine_id: string; active_descriptor_id: string | null }>
}

/**
 * The `descriptor_id` a probe of `engineId` names. The installed engine's own descriptor when there
 * is one; otherwise the engine id, which is never a real descriptor id, so the core plans with that
 * engine's newest descriptor it can get and names it in the plan (ruling R-app-4).
 */
export function descriptorHint(environments: EnvironmentView[], engineId: string): string {
  for (const environment of environments) {
    const installed = environment.installations.find(
      (installation) => installation.engine_id === engineId && installation.active_descriptor_id
    )
    if (installed?.active_descriptor_id) return installed.active_descriptor_id
  }
  return engineId
}
