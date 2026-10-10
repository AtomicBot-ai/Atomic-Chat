import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageItem } from '../MessageItem'
import { seedServiceHub } from '@/test/service-hub'

const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { error: toastError } }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (s: unknown) => unknown) =>
    selector({ selectedModel: { id: 'test-model' } }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (selector: (s: unknown) => unknown) =>
    selector({ disableReasoning: false }),
}))

const FILE_ID = 'af1035b9-6c1e-4c39-9d0e-6f1c3b2a7e10'
const PATH = '/Users/me/docs/FINDINGS.md'

const answer = (
  citation: Record<string, unknown>,
  text: string
): UIMessage => ({
  id: 'rag-answer',
  role: 'assistant',
  parts: [
    {
      type: 'tool-retrieve',
      toolCallId: 'retrieve-1',
      state: 'output-available',
      input: { query: 'MiniLM vector dimension' },
      output: [
        {
          type: 'text',
          text: JSON.stringify({
            thread_id: 'p1',
            project_id: 'p1',
            scope: 'project',
            queries: ['MiniLM vector dimension'],
            citations: [
              {
                text: 'The MiniLM test returned an embedding vector dimension of 384.',
                score: 0.64,
                file_id: FILE_ID,
                chunk_file_order: 12,
                ...citation,
              },
            ],
            // Removed files are not listed; legacy outputs had no sources.
            sources:
              citation.removed || citation.id
                ? []
                : [
                    {
                      file_id: FILE_ID,
                      name: 'FINDINGS.md',
                      path: PATH,
                      passages: 42,
                    },
                  ],
            mode: 'linear',
          }),
        },
      ],
    } as UIMessage['parts'][number],
    { type: 'text', text },
  ],
})

const renderAnswer = (message: UIMessage) =>
  render(
    <MessageItem
      message={message}
      isFirstMessage={false}
      isLastMessage
      status="ready"
    />
  )

const opener = () => ({
  open: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
})

beforeEach(() => {
  toastError.mockReset()
  seedServiceHub()
})

// ATO-551: answers cited `chunk efeb2156-…` and `file af1035b9-…`.
describe('MessageItem document citations', () => {
  it('shows a cited passage as a chip with the file name and opens the file', async () => {
    const services = opener()
    seedServiceHub({ opener: services })

    renderAnswer(
      answer(
        { cite: '[FINDINGS.md §13]', source: 'FINDINGS.md', passage: 13 },
        'The vector has 384 dimensions [FINDINGS.md §13].'
      )
    )

    const chip = screen.getByTestId('doc-citation-chip')
    expect(chip).toHaveTextContent('FINDINGS.md')
    expect(chip).toHaveTextContent('§13')
    expect(screen.queryByText(/af1035b9/)).not.toBeInTheDocument()

    await userEvent.click(chip)
    const card = await screen.findByTestId('doc-citation-card')
    expect(card).toHaveTextContent(
      'The MiniLM test returned an embedding vector dimension of 384.'
    )
    expect(card).toHaveTextContent(
      'docCitation.passageOf {"passage":13,"total":42}'
    )

    await userEvent.click(within(card).getByText('docCitation.showInFolder'))
    await userEvent.click(within(card).getByText('docCitation.open'))
    expect(services.revealItemInDir).toHaveBeenCalledWith(PATH)
    expect(services.openPath).toHaveBeenCalledWith(PATH)
  })

  it('says a removed source was removed and offers nothing to open', async () => {
    seedServiceHub({ opener: opener() })

    renderAnswer(
      answer(
        {
          cite: '[removed document §13]',
          source: 'removed document',
          passage: 13,
          removed: true,
        },
        'It was 384 [removed document §13].'
      )
    )

    const chip = screen.getByTestId('doc-citation-chip')
    expect(chip).toHaveTextContent('docCitation.removedDocument')
    await userEvent.click(chip)
    const card = await screen.findByTestId('doc-citation-card')
    expect(within(card).getByRole('status')).toHaveTextContent(
      'docCitation.removedFromProject'
    )
    expect(card).toHaveTextContent('vector dimension of 384')
    expect(within(card).queryByText('docCitation.open')).not.toBeInTheDocument()
  })

  it('reports a file that moved instead of failing silently', async () => {
    const services = opener()
    services.openPath.mockRejectedValue(new Error('No such file'))
    seedServiceHub({ opener: services })

    renderAnswer(
      answer(
        { cite: '[FINDINGS.md §13]', source: 'FINDINGS.md', passage: 13 },
        'Cited [FINDINGS.md §13].'
      )
    )

    await userEvent.click(screen.getByTestId('doc-citation-chip'))
    const card = await screen.findByTestId('doc-citation-card')
    await userEvent.click(within(card).getByText('docCitation.open'))

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0][0]).toBe(
      'docCitation.openFailed {"name":"FINDINGS.md"}'
    )
    expect(card).toHaveTextContent('vector dimension of 384')
  })

  it('links the raw chunk id of an answer written before readable labels', () => {
    const chunkId = 'efeb2156-1a2b-4c3d-8e9f-0a1b2c3d4e5f'

    renderAnswer(answer({ id: chunkId }, `Source: chunk ${chunkId}.`))

    const chip = screen.getByTestId('doc-citation-chip')
    expect(chip).toHaveTextContent('docCitation.document')
    expect(chip).toHaveTextContent('§13')
    expect(screen.queryByText(new RegExp(chunkId))).not.toBeInTheDocument()
  })
})
