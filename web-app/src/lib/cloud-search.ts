/**
 * The search params the Cloud page reads: which provider is selected. Shared by
 * `/settings/cloud` and the old `/cloud` address that forwards to it.
 */
export const validateCloudSearch = (
  search: Record<string, unknown>
): { provider?: string } => {
  // Absent must stay absent — `String(undefined)` would put the literal
  // "undefined" in the URL and then fail to match any provider.
  const provider = search?.provider
  return typeof provider === 'string' && provider.length > 0 ? { provider } : {}
}
