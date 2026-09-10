type SerializedModelError = {
  code?: string
  message?: string
  details?: string
}

export function extractModelErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const e = error as SerializedModelError
    if (typeof e.message === 'string' && e.message.trim()) return e.message
  }
  if (typeof error === 'string') return error
  return 'Unknown error'
}
