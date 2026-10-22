/**
 * Whether this build ships the local API server the purpose and server
 * steps lead to.
 * Reports nothing until the step is built, which keeps the step out of the
 * flow (`lib/onboarding/steps`).
 */
export function useLocalApiServerOffered(): boolean {
  return false
}
