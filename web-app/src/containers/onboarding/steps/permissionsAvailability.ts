/**
 * Permissions this platform can actually ask for, as rows of the permissions
 * step.
 * Reports nothing until the step is built, which keeps the step out of the
 * flow (`lib/onboarding/steps`).
 */
export function usePermissionRowCount(): number {
  return 0
}
