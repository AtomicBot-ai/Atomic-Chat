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
