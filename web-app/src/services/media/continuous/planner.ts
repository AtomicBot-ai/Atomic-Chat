/**
 * Timeline planner: one overall story -> one prompt per segment.
 *
 * The user's local chat model (whatever is selected in chat, served through the
 * existing llama.cpp/ModelFactory path) writes a markdown timeline. When no
 * chat model is available or its answer cannot be parsed, a deterministic
 * splitter produces the same shape, so planning never blocks a session.
 *
 * The markdown is also the on-disk format (`plan.md` beside the session), so
 * the parser accepts what the user hand-edits as well as what the model wrote.
 */

export type PlanSegment = {
  index: number
  prompt: string
  length_seconds?: number
}

export type TimelinePlan = {
  story: string
  segment_count: number
  length_seconds?: number
  segments: PlanSegment[]
  /** `model` when the chat model wrote it, `fallback` for the splitter. */
  source: 'model' | 'fallback' | 'manual'
}

export type PlanRequest = {
  story: string
  segments: number
  length_seconds?: number
}

export function clampSegmentCount(count: number): number {
  if (!Number.isFinite(count)) return 1
  return Math.max(1, Math.min(50, Math.floor(count)))
}

/** The instruction given to the chat model. */
export function buildPlannerPrompt(request: PlanRequest): { system: string; prompt: string } {
  const n = clampSegmentCount(request.segments)
  const len = request.length_seconds ? ` of about ${request.length_seconds} seconds each` : ''
  return {
    system:
      'You are a film storyboard writer for a text-to-video model. ' +
      'Split the story into consecutive shots that advance it progressively. ' +
      'Every shot prompt must repeat the same concrete subject and setting descriptors ' +
      '(appearance, clothing, location, lighting, time of day) so consecutive clips stay consistent. ' +
      'Describe only what is visible in that shot, in one or two sentences. ' +
      'Answer ONLY with markdown in exactly this form, nothing else:\n' +
      '## Segment 1\n<prompt>\n\n## Segment 2\n<prompt>',
    prompt: `Story: ${request.story.trim()}\n\nWrite exactly ${n} segments${len}.`,
  }
}

const HEADING = /^#{2,3}\s*(?:segment|shot|scene|part)?\s*(\d+)?[^\n]*$/i
const LENGTH = /\((\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\)/i

function cleanBody(lines: string[]): string {
  return lines
    .map((line) =>
      line
        .replace(/^\s*[-*>]\s+/, '')
        .replace(/^\s*\*{0,2}prompt\s*:\s*\*{0,2}\s*/i, '')
        .trim()
    )
    .filter((line) => line.length > 0 && !/^```/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse a markdown timeline. Sections are `##`/`###` headings; a heading's
 * `(30s)` sets that segment's length. Text before the first heading is
 * ignored (title, story recap). Empty sections are kept as blank prompts, which
 * the session then inherits from the previous segment.
 */
export function parsePlanMarkdown(markdown: string): PlanSegment[] {
  const segments: PlanSegment[] = []
  let current: { heading: string; lines: string[] } | undefined
  const flush = () => {
    if (!current) return
    const length = LENGTH.exec(current.heading)
    segments.push({
      index: segments.length,
      prompt: cleanBody(current.lines),
      ...(length ? { length_seconds: Number(length[1]) } : {}),
    })
  }
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (HEADING.test(line.trim())) {
      flush()
      current = { heading: line.trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  flush()
  return segments
}

/** Render a plan as the markdown stored in `plan.md` and shown for editing. */
export function planToMarkdown(plan: Pick<TimelinePlan, 'story' | 'segments' | 'length_seconds'>): string {
  const header = [`# Timeline`, '', `Story: ${plan.story.trim()}`, '']
  const body = plan.segments.flatMap((segment, i) => {
    const len = segment.length_seconds ?? plan.length_seconds
    return [`## Segment ${i + 1}${len ? ` (${len}s)` : ''}`, segment.prompt.trim(), '']
  })
  return [...header, ...body].join('\n')
}

const PHASES = ['begins', 'continues', 'progresses', 'approaches', 'reaches', 'concludes']

function phaseFor(i: number, n: number): string {
  if (n === 1) return ''
  if (i === 0) return 'Opening shot'
  if (i === n - 1) return 'Final shot'
  const middle = PHASES.slice(1, -1)
  return `Shot ${i + 1}, the action ${middle[Math.floor(((i - 1) / Math.max(1, n - 2)) * middle.length)]}`
}

/** Split a story into ordered beats on sentence and clause boundaries. */
export function storyBeats(story: string): string[] {
  return story
    .split(/(?:[.;!?]+\s*|,\s*(?:and\s+)?then\s+|\s+and\s+then\s+|\s+then\s+|\s+and\s+|,\s+)/i)
    .map((beat) => beat.trim())
    .filter((beat) => beat.length > 0)
}

/**
 * The no-model fallback. Deterministic: the story's first beat is the
 * consistency anchor repeated in every prompt, and the beats are spread across
 * the segments in order, so the story advances monotonically.
 */
export function fallbackPlan(request: PlanRequest): TimelinePlan {
  const n = clampSegmentCount(request.segments)
  const story = request.story.trim()
  const beats = storyBeats(story)
  const anchor = story
  const segments: PlanSegment[] = []
  for (let i = 0; i < n; i++) {
    const beat = beats.length === 0 ? story : beats[Math.min(beats.length - 1, Math.floor((i * beats.length) / n))]!
    const phase = phaseFor(i, n)
    const prompt = n === 1 ? story : `${phase}: ${beat}. Continuity: ${anchor}.`
    segments.push({
      index: i,
      prompt,
      ...(request.length_seconds ? { length_seconds: request.length_seconds } : {}),
    })
  }
  return {
    story,
    segment_count: n,
    ...(request.length_seconds ? { length_seconds: request.length_seconds } : {}),
    segments,
    source: 'fallback',
  }
}

/**
 * Fit what the model returned to exactly `n` segments: extra sections are
 * dropped, missing or empty ones are filled from the fallback.
 */
export function reconcilePlan(parsed: PlanSegment[], request: PlanRequest): TimelinePlan | undefined {
  const n = clampSegmentCount(request.segments)
  const usable = parsed.filter((segment) => segment.prompt.length > 0)
  if (usable.length === 0) return undefined
  const fallback = fallbackPlan(request)
  const segments = Array.from({ length: n }, (_, i) => ({
    index: i,
    prompt: usable[i]?.prompt ?? fallback.segments[i]!.prompt,
    ...(request.length_seconds ? { length_seconds: request.length_seconds } : {}),
  }))
  return {
    story: request.story.trim(),
    segment_count: n,
    ...(request.length_seconds ? { length_seconds: request.length_seconds } : {}),
    segments,
    source: 'model',
  }
}

export type PlannerDeps = {
  /** Runs the chat model; `undefined` when no chat model is available. */
  complete?: (input: { system: string; prompt: string }) => Promise<string>
  warn?: (message: string, cause?: unknown) => void
}

export async function planTimeline(request: PlanRequest, deps: PlannerDeps): Promise<TimelinePlan> {
  if (!request.story.trim()) throw new Error('Write a story first.')
  if (deps.complete) {
    try {
      const text = await deps.complete(buildPlannerPrompt(request))
      const plan = reconcilePlan(parsePlanMarkdown(stripThinking(text)), request)
      if (plan) return plan
      deps.warn?.('The chat model answer had no segments; using the fallback splitter.')
    } catch (error) {
      deps.warn?.('The chat model could not plan the timeline; using the fallback splitter.', error)
    }
  }
  return fallbackPlan(request)
}

/** Reasoning models wrap their scratchpad in <think>; it is never the plan. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}
