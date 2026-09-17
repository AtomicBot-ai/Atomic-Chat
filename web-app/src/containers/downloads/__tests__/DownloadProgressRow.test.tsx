import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { DownloadProgressRow } from '../DownloadProgressRow'

// Echo the key plus its interpolations, so an assertion proves which branch
// ran and with what numbers, without depending on the English wording.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0
        ? `${key}(${Object.entries(options)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')})`
        : key,
  }),
}))

/**
 * ATO — #290: with an unreachable host the transfer reports total=0 for its
 * whole life, so this row is the only thing the user sees for ~60s. It used to
 * read "Starting…" the entire time.
 */
describe('DownloadProgressRow status while no bytes have moved', () => {
  it('says which retry it is on', () => {
    render(
      <DownloadProgressRow
        id="AtomicChat/some-model"
        progress={0}
        current={0}
        total={0}
        stage={{ kind: 'retrying', attempt: 2, maxAttempts: 5 }}
      />
    )

    expect(
      screen.getByText('common:downloadPanel.retrying(attempt=2,maxAttempts=5)')
    ).toBeTruthy()
  })

  it('says it is connecting before the first attempt fails', () => {
    render(
      <DownloadProgressRow
        id="AtomicChat/some-model"
        progress={0}
        current={0}
        total={0}
        stage={{ kind: 'connecting', attempt: 0, maxAttempts: 5 }}
      />
    )

    expect(screen.getByText('common:downloadPanel.connecting')).toBeTruthy()
  })

  it('falls back to the plain preparing state with no stage', () => {
    render(
      <DownloadProgressRow
        id="AtomicChat/some-model"
        progress={0}
        current={0}
        total={0}
      />
    )

    expect(screen.getByText('common:downloadPanel.preparing')).toBeTruthy()
  })

  it('shows the percentage once the size is known, stage or not', () => {
    render(
      <DownloadProgressRow
        id="AtomicChat/some-model"
        progress={0.42}
        current={420}
        total={1000}
        stage={{ kind: 'retrying', attempt: 1, maxAttempts: 5 }}
      />
    )

    expect(screen.getByText(/42%/)).toBeTruthy()
  })

  it('keeps saying paused even mid-ladder', () => {
    render(
      <DownloadProgressRow
        id="AtomicChat/some-model"
        progress={0}
        current={0}
        total={0}
        paused
        stage={{ kind: 'retrying', attempt: 3, maxAttempts: 5 }}
      />
    )

    expect(screen.getByText('common:downloadPanel.paused')).toBeTruthy()
  })
})

const MB = 1024 * 1024
const GB = MB * 1024

/**
 * 2.0.39, Danny's test drive: the size pair wrapped onto a second line and the
 * card grew. The readout was two flex spans, and past the row's width the
 * first one — the one without `nowrap` — broke at its spaces. The row keeps
 * the whole readout on one line now, ordered by what matters most, so the
 * part that gives way when a line has to be cut is the estimate at its end.
 */
describe('DownloadProgressRow readout line', () => {
  const transfer = {
    id: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    progress: 0.42,
    current: 4.2 * GB,
    total: 12.4 * GB,
    // 8.2 GB left at 18.4 MB/s is 456 s: 7m 36s.
    bytesPerSecond: 18.4 * MB,
  }
  const line = '42% · 4.20 / 12.40 GB · common:downloadPanel.left(eta=7m 36s)'

  it('states percent, size and time left on one line, in that order', () => {
    render(<DownloadProgressRow {...transfer} />)

    expect(screen.getByText(line)).toBeInTheDocument()
  })

  it('never lets the line wrap: one element, nowrap, tabular digits', () => {
    render(<DownloadProgressRow {...transfer} />)

    // `truncate` is nowrap plus an ellipsis: a line that cannot fit is cut at
    // its end — the estimate — instead of pushing the card up by a row.
    expect(screen.getByText(line)).toHaveClass('truncate', 'tabular-nums')
  })

  it('leaves the transfer speed out of the row', () => {
    render(<DownloadProgressRow {...transfer} />)

    expect(screen.queryByText(/MB\/s/)).not.toBeInTheDocument()
  })

  it('reads Paused with the size and no estimate', () => {
    render(<DownloadProgressRow {...transfer} paused />)

    expect(
      screen.getByText('common:downloadPanel.paused · 4.20 / 12.40 GB')
    ).toBeInTheDocument()
  })

  it('omits the estimate until there is a rate to base it on', () => {
    render(<DownloadProgressRow {...transfer} bytesPerSecond={0} />)

    expect(screen.getByText('42% · 4.20 / 12.40 GB')).toBeInTheDocument()
  })

  it('truncates a long model name and keeps the full id as its tooltip', () => {
    render(<DownloadProgressRow {...transfer} />)

    const name = screen.getByTitle(transfer.id)
    expect(name).toHaveTextContent('Qwen3-Coder-30B-A3B-Instruct-GGUF')
    expect(name).toHaveClass('truncate')
  })

  it('keeps pause and cancel in a slot that never shrinks', () => {
    render(<DownloadProgressRow {...transfer} pausable />)

    const slot = screen.getByLabelText('common:cancelDownload').parentElement
    expect(slot).toHaveClass('shrink-0')
    expect(slot).toContainElement(screen.getByLabelText('common:pauseDownload'))
  })
})
