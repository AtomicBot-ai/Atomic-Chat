import { localStorageKey } from '@/constants/localStorage'

/**
 * Did this install ever have Agent mode switched on for a thread?
 *
 * Until v2.0.32 Agent mode was per-thread, persisted as `agentThreads` in the
 * `agent-mode` store. v2.0.33 replaced it with one global `agentModeEnabled`
 * flag in `setting-general` that defaults to `false`, and the `agent-mode`
 * v3 migration deletes `agentThreads` outright — with nothing carrying the
 * user's choice across. Everyone who had been running threads on the agent
 * engine was silently moved back to the chat pipeline, which is also where
 * agent skills stop reaching the model.
 *
 * The two stores hydrate independently and whichever goes first wins, so the
 * probe is captured at module load *and* fed by the `agent-mode` migration
 * itself (`captureLegacyAgentThreads`). Either order yields the same answer.
 *
 * Limitation, deliberately not papered over: this can only rescue an install
 * that has not yet run v2.0.33+. Once that migration has deleted
 * `agentThreads`, the choice is gone from disk and no later release can
 * recover it — those users have to flip the toggle in the composer's "+" menu.
 */
let hadLegacyAgentThread = probeLegacyAgentThreads()

function probeLegacyAgentThreads(): boolean {
  try {
    const raw = localStorage.getItem(localStorageKey.agentMode)
    if (!raw) return false
    const parsed = JSON.parse(raw) as {
      state?: { agentThreads?: Record<string, unknown> }
    }
    return anyThreadEnabled(parsed?.state?.agentThreads)
  } catch {
    // Unparseable, or storage unavailable (private windows, blocked site
    // data). Not a reason to fail a migration.
    return false
  }
}

function anyThreadEnabled(threads: Record<string, unknown> | undefined) {
  if (!threads || typeof threads !== 'object') return false
  return Object.values(threads).some((enabled) => enabled === true)
}

/**
 * Record the legacy per-thread flags before they are deleted. Called by the
 * `agent-mode` store's v3 migration so the signal survives regardless of
 * which store hydrates first.
 */
export function captureLegacyAgentThreads(
  threads: Record<string, unknown> | undefined
): void {
  if (anyThreadEnabled(threads)) hadLegacyAgentThread = true
}

/** True when Agent mode was on for at least one thread before v2.0.33. */
export function hadLegacyPerThreadAgentMode(): boolean {
  return hadLegacyAgentThread
}

/** Test seam: reset the captured probe. */
export function resetLegacyAgentModeProbe(): void {
  hadLegacyAgentThread = probeLegacyAgentThreads()
}
