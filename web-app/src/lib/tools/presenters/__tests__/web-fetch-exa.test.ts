import { describe, expect, it } from 'vitest'
import { presentWebFetchExa } from '../web-fetch-exa'

describe('presentWebFetchExa', () => {
  it('reads pages from the bundled keyless fetch envelope', () => {
    const presentation = presentWebFetchExa({
      input: { urls: ['https://example.com/article'] },
      output: [
        {
          text: JSON.stringify({
            status: 'ok',
            summary: 'First paragraph.\n\nSecond paragraph.',
            details: {
              title: 'Example article',
              url: 'https://example.com/article',
              finalUrl: 'https://example.com/article',
            },
          }),
        },
      ],
    })

    expect(presentation).toMatchObject({
      kind: 'web_fetch_exa',
      title: 'Fetched 1 pages',
      pages: [
        {
          title: 'Example article',
          url: 'https://example.com/article',
          domain: 'example.com',
          highlights: ['First paragraph.', 'Second paragraph.'],
        },
      ],
    })
  })
})
