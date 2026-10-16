import { describe, expect, it, vi } from 'vitest'
import {
  buildPlannerPrompt,
  fallbackPlan,
  parsePlanMarkdown,
  planTimeline,
  planToMarkdown,
  stripThinking,
} from '../planner'

const story = 'man walks down the street and walks into a doorway to his house'

describe('parsePlanMarkdown', () => {
  it('reads ## sections, lengths, bullets and Prompt: prefixes', () => {
    const md = `# Timeline\nStory: x\n\n## Segment 1 (30s)\n**Prompt:** a man walks\n\n## Segment 2\n- past shops\n- at dusk\n\n### Shot 3\n\n`
    expect(parsePlanMarkdown(md)).toEqual([
      { index: 0, prompt: 'a man walks', length_seconds: 30 },
      { index: 1, prompt: 'past shops at dusk' },
      { index: 2, prompt: '' },
    ])
  })
  it('round-trips planToMarkdown', () => {
    const plan = fallbackPlan({ story, segments: 4, length_seconds: 30 })
    const parsed = parsePlanMarkdown(planToMarkdown(plan))
    expect(parsed.map((p) => p.prompt)).toEqual(plan.segments.map((s) => s.prompt))
    expect(parsed.every((p) => p.length_seconds === 30)).toBe(true)
  })
  it('strips <think> blocks', () => {
    expect(stripThinking('<think>hmm\n## Segment 9</think>\n## Segment 1\nok')).toBe('## Segment 1\nok')
  })
})

describe('fallbackPlan', () => {
  it('is deterministic, has exactly N segments and advances the story in order', () => {
    const a = fallbackPlan({ story, segments: 4, length_seconds: 30 })
    expect(a).toEqual(fallbackPlan({ story, segments: 4, length_seconds: 30 }))
    expect(a.segments).toHaveLength(4)
    expect(a.source).toBe('fallback')
    expect(a.segments[0]!.prompt).toMatch(/^Opening shot: man walks down the street/)
    expect(a.segments[3]!.prompt).toMatch(/^Final shot: walks into a doorway/)
    // Consistency anchor repeated in every prompt.
    for (const s of a.segments) expect(s.prompt).toContain(story)
  })
  it('a single segment is the story itself', () => {
    expect(fallbackPlan({ story, segments: 1 }).segments[0]!.prompt).toBe(story)
  })
})

describe('planTimeline', () => {
  it('uses the chat model answer, padded/truncated to N', async () => {
    const complete = vi.fn().mockResolvedValue('## Segment 1\nquiet street\n## Segment 2\nshops\n')
    const plan = await planTimeline({ story, segments: 3 }, { complete })
    expect(plan.source).toBe('model')
    expect(plan.segments.map((s) => s.prompt).slice(0, 2)).toEqual(['quiet street', 'shops'])
    expect(plan.segments).toHaveLength(3)
    expect(complete.mock.calls[0]![0].prompt).toContain('exactly 3 segments')
  })
  it('falls back when no model is loaded, it throws, or it answers garbage', async () => {
    expect((await planTimeline({ story, segments: 2 }, {})).source).toBe('fallback')
    expect((await planTimeline({ story, segments: 2 }, { complete: () => Promise.reject(new Error('x')) })).source).toBe('fallback')
    expect((await planTimeline({ story, segments: 2 }, { complete: async () => 'sure!' })).source).toBe('fallback')
  })
  it('rejects an empty story', async () => {
    await expect(planTimeline({ story: ' ', segments: 2 }, {})).rejects.toThrow()
  })
  it('prompt asks for consistent descriptors', () => {
    expect(buildPlannerPrompt({ story, segments: 4, length_seconds: 30 }).system).toMatch(/same concrete subject and setting/)
  })
})
