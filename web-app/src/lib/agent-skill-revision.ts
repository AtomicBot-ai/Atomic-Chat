/**
 * Monotonic counter bumped whenever an agent skill is created, imported,
 * updated, enabled/disabled or deleted.
 *
 * Consumers that memoize skill bodies (the chat transport's
 * `skillDetailCache`) compare the revision they cached at against the current
 * one and drop their cache when it moves. Without it an edited SKILL.md never
 * reached the model inside an already-open thread: the transport lives for the
 * session, so the pre-edit body stayed frozen in its map until an app restart.
 *
 * Deliberately a bare module-level counter rather than a store: it has to be
 * readable from `chat-skill-injection.ts`, which must not pull
 * `@tauri-apps/api` into the web build or the vitest harness (see the lazy
 * import there), and skills mutate rarely enough that no subscription is
 * needed — the next send re-reads it.
 */
let revision = 0

/** Called by every mutating skill service call. */
export function bumpAgentSkillRevision(): void {
  revision += 1
}

/** Current revision; compare against a previously captured value. */
export function agentSkillRevision(): number {
  return revision
}
