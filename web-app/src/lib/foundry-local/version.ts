const RUNTIME_VERSION = /^\d+\.\d+\.\d+$/

function versionParts(value: string): bigint[] | null {
  if (value !== value.trim() || !RUNTIME_VERSION.test(value)) return null
  return value.split('.').map((part) => BigInt(part))
}

/** Azure's unset, invalid and all-zero minima impose no runtime requirement. */
export function minimumFoundryRuntimeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return versionParts(value)?.some((part) => part !== 0n) ? value : null
}

/** Core uses a leading v in build tags and omits it in runtime versions. */
export function foundryRuntimeMeetsMinimum(version: string, minimum: string): boolean | null {
  const active = versionParts(version.replace(/^v/, ''))
  const required = versionParts(minimum)
  if (!active || !required) return null
  for (const [index, component] of active.entries()) {
    if (component !== required[index]) return component > required[index]
  }
  return true
}
