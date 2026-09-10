
const silentImportIds = new Set<string>()

export function markSilentImport(modelId: string): void {
  silentImportIds.add(modelId)
}

export function consumeSilentImport(modelId: string): boolean {
  return silentImportIds.delete(modelId)
}
