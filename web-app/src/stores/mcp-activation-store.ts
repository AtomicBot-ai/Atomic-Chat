import { create } from 'zustand'

/**
 * MCP servers being switched on from the Connectors page, and why the last
 * attempt for a server failed.
 *
 * A failed activation leaves the server inactive, and the backend's status
 * list only speaks for servers that are running or were marked active, so
 * without this the card went back to "Inactive" as if nothing had been tried.
 * Outside React because an activation outlives the page that started it (it
 * can take the whole handshake timeout), and in memory because it describes
 * this session's attempt, not the server's configuration.
 */
type McpActivationState = {
  connecting: Record<string, true>
  errors: Record<string, string>
  /** An activation of `key` started: it is connecting, with no error yet. */
  start: (key: string) => void
  /** It came up. */
  succeed: (key: string) => void
  /** It did not, and this is why. */
  fail: (key: string, message: string) => void
  /** Forget `key`: it was switched off, edited or deleted. */
  clear: (key: string) => void
}

const without = <T>(record: Record<string, T>, key: string) => {
  if (!(key in record)) return record
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [key]: _, ...rest } = record
  return rest
}

export const useMcpActivationStore = create<McpActivationState>((set) => ({
  connecting: {},
  errors: {},
  start: (key) =>
    set((state) => ({
      connecting: { ...state.connecting, [key]: true },
      errors: without(state.errors, key),
    })),
  succeed: (key) =>
    set((state) => ({
      connecting: without(state.connecting, key),
      errors: without(state.errors, key),
    })),
  fail: (key, message) =>
    set((state) => ({
      connecting: without(state.connecting, key),
      errors: { ...state.errors, [key]: message },
    })),
  clear: (key) =>
    set((state) => ({
      connecting: without(state.connecting, key),
      errors: without(state.errors, key),
    })),
}))

/** A readable reason from whatever an activation rejected with. */
export function mcpActivationErrorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
