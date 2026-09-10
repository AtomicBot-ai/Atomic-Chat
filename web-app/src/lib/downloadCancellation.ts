const CANCEL_TTL_MS = 15000

const requestedCancellations = new Map<string, number>()

export function markDownloadCancellationRequested(id: string) {
  requestedCancellations.set(id, Date.now())
}

export function wasDownloadCancellationRequested(id: string): boolean {
  const requestedAt = requestedCancellations.get(id)
  if (!requestedAt) return false

  if (Date.now() - requestedAt > CANCEL_TTL_MS) {
    requestedCancellations.delete(id)
    return false
  }

  return true
}

export function clearDownloadCancellationRequested(id: string) {
  requestedCancellations.delete(id)
}
