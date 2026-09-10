import { describe, it, expect } from 'vitest'
import { presentWebSearchExa } from '../web-search-exa'

// Exa returns every result inside a single output text item, with individual
// results separated by a `---` horizontal rule.
const makeEntry = (n: number) =>
  [
    `Title: Result ${n}`,
    `URL: https://example.com/${n}`,
    `Published: 2024-01-0${n}`,
    `Author: Author ${n}`,
    'Highlights:',
    `highlight ${n}a`,
    `highlight ${n}b`,
  ].join('\n')

const combinedBlock = (count: number) =>
  Array.from({ length: count }, (_, i) => makeEntry(i + 1)).join('\n\n---\n\n')

describe('presentWebSearchExa', () => {
  it('renders every result when Exa packs them into one text block', () => {
    const presentation = presentWebSearchExa({
      input: { query: 'cafe photos' },
      output: [{ text: combinedBlock(5) }],
    })

    expect(presentation.kind).toBe('web_search_exa')
    expect(presentation.results).toHaveLength(5)
    expect(presentation.subtitle).toBe('5 results')
    expect(presentation.results.map((r) => r.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
      'https://example.com/4',
      'https://example.com/5',
    ])
    expect(presentation.results[0].title).toBe('Result 1')
    expect(presentation.results[0].domain).toBe('example.com')
    expect(presentation.results[0].highlights).toEqual([
      'highlight 1a',
      'highlight 1b',
    ])
  })

  it('handles a single result with no separator', () => {
    const presentation = presentWebSearchExa({
      input: { query: 'q' },
      output: [{ text: makeEntry(1) }],
    })

    expect(presentation.results).toHaveLength(1)
    expect(presentation.subtitle).toBe('1 result')
    expect(presentation.results[0].title).toBe('Result 1')
  })

  it('still handles one result per output item (array shape)', () => {
    const presentation = presentWebSearchExa({
      input: { query: 'q' },
      output: [{ text: makeEntry(1) }, { text: makeEntry(2) }],
    })

    expect(presentation.results).toHaveLength(2)
    expect(presentation.subtitle).toBe('2 results')
  })

  it('returns no results for empty output', () => {
    const presentation = presentWebSearchExa({
      input: { query: 'q' },
      output: [],
    })
    expect(presentation.results).toHaveLength(0)
    expect(presentation.subtitle).toBeUndefined()
  })
})
