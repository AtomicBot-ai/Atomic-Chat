import { isChatCompatibleSkill } from '@/containers/agentSkillSlash'
import { readAgentSkillName } from '@/lib/agent-skill-selection'
import type { AgentSkillDetail } from '@/services/agent/skills'

/**
 * Skills on the chat pipeline: the agent engine loads SKILL.md bodies through
 * its `skill.view` tool; the chat transport instead appends the invoked
 * skills' bodies to the system prompt. Caps mirror the agent side
 * (`src-tauri/src/core/agent/skills/loaded.rs`): per-skill body 16k chars,
 * whole block 32k, at most 6 skills.
 */
export const CHAT_SKILLS_CAP = 6
export const CHAT_SKILL_BODY_MAX_CHARS = 16_000
export const CHAT_SKILLS_BLOCK_MAX_CHARS = 32_000

const TRUNCATION_MARKER = '\n[truncated]'

type MessageLike = {
  role: string
  metadata?: unknown
}

function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`
}

/**
 * Skill names invoked across the thread's user turns, deduped keeping the
 * most recent occurrence, capped to the last `CHAT_SKILLS_CAP`. Mirrors the
 * agent's LRU semantics: a skill invoked earlier stays active on later turns
 * and on regenerate.
 */
export function collectSkillNamesFromMessages(
  messages: MessageLike[]
): string[] {
  const ordered: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const metadata = message.metadata
    if (!metadata || typeof metadata !== 'object') continue
    const name = readAgentSkillName(metadata as Record<string, unknown>)
    if (!name) continue
    const existing = ordered.indexOf(name)
    if (existing !== -1) ordered.splice(existing, 1)
    ordered.push(name)
  }
  return ordered.slice(-CHAT_SKILLS_CAP)
}

/**
 * Render the invoked skills as a system-prompt block. Returns undefined when
 * there is nothing to render.
 */
export function renderChatSkillsBlock(
  skills: Array<Pick<AgentSkillDetail, 'name' | 'version' | 'body'>>
): string | undefined {
  if (skills.length === 0) return undefined
  const header =
    '## Invoked skills\nThe user invoked the following skills. Follow their instructions where relevant.'
  const sections = skills.map(
    (skill) =>
      `# skill: ${skill.name} (v${skill.version})\n${truncateChars(
        skill.body.trim(),
        CHAT_SKILL_BODY_MAX_CHARS
      )}`
  )
  return truncateChars(
    [header, ...sections].join('\n\n'),
    CHAT_SKILLS_BLOCK_MAX_CHARS
  )
}

/** Join the assistant instructions and the skills block, if any. */
export function composeSystemMessage(
  base: string | undefined,
  skillsBlock: string | undefined
): string | undefined {
  if (base && skillsBlock) return `${base}\n\n${skillsBlock}`
  return base || skillsBlock || undefined
}

/**
 * Load skill bodies by name, memoized in `cache` (null = known-unusable).
 * Skips — never throws — on IPC errors, disabled skills and skills the chat
 * pipeline can't serve (scripts / unavailable tools): a skill deleted or
 * disabled after it was invoked must not brick a regenerate. Softer than the
 * agent, which fails the turn on a broken selected skill.
 */
export async function loadChatSkillDetails(
  names: string[],
  cache: Map<string, AgentSkillDetail | null>,
  availableToolNames: ReadonlySet<string>
): Promise<AgentSkillDetail[]> {
  if (!IS_TAURI || names.length === 0) return []
  const details: AgentSkillDetail[] = []
  for (const name of names) {
    if (!cache.has(name)) {
      try {
        // Lazy import keeps the module graph free of `@tauri-apps/api` for
        // the web build and the vitest harness.
        const { getAgentSkill } = await import('@/services/agent/skills')
        const detail = await getAgentSkill(name)
        const usable =
          detail.enabled &&
          !detail.error &&
          isChatCompatibleSkill(detail, availableToolNames)
        cache.set(name, usable ? detail : null)
      } catch (error) {
        console.warn(`Skipping chat skill "${name}":`, error)
        cache.set(name, null)
      }
    }
    const cached = cache.get(name)
    if (cached) details.push(cached)
  }
  return details
}
