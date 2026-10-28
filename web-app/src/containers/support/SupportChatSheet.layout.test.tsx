import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, describe, expect, it } from 'vitest'

import i18n from '@/i18n/setup'
import { useSupportChatStore } from '@/stores/support-chat-store'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { SupportChatSheet } from './SupportChatSheet'

// Worst cases: a pasted log line with no spaces, and the longer Russian copy.
const LOG_LINE =
  'llama_model_load:/Users/someone/Library/Application_Support/Atomic_Chat/models/' +
  'VeryLongModelName'.repeat(8) +
  '-Q4_K_M.gguf:failed_to_allocate_buffer'

const seed = () =>
  useSupportChatStore.setState({
    conversationId: 'c-1',
    token: 'tok',
    lastSeq: 2,
    lastReadSeq: 2,
    metaHash: 'hash',
    sheetOpen: true,
    messages: [
      {
        id: '1',
        clientId: 'a',
        seq: 1,
        author: 'user',
        text: LOG_LINE,
        createdAt: '2026-10-24T09:00:00Z',
        status: 'sent',
      },
      {
        id: '2',
        seq: 2,
        author: 'team',
        text: `Thanks. Could you try the upstream engine? ${LOG_LINE}`,
        createdAt: '2026-10-24T09:05:00Z',
        status: 'sent',
      },
      {
        id: 'b',
        clientId: 'b',
        author: 'user',
        text: 'One more question',
        createdAt: '2026-10-24T09:06:00Z',
        status: 'failed',
        error: 'rate_limited',
      },
      {
        id: 'c',
        clientId: 'c',
        author: 'user',
        text: 'And another',
        createdAt: '2026-10-24T09:07:00Z',
        status: 'pending',
      },
    ],
  })

afterEach(() => {
  useSupportChatStore.setState({ sheetOpen: false, messages: [] })
})

describe.each(['light', 'dark'] as const)(
  'support chat in %s theme',
  (theme) => {
    it.each(
      ['en', 'ru'].flatMap((language) =>
        [DEFAULT_FONT_SIZE, XL_FONT_SIZE].map((fontSize) => ({
          language,
          fontSize,
        }))
      )
    )(
      'keeps every message inside the sheet in $language at $fontSize',
      async ({ language, fontSize }) => {
        await page.viewport(1024, 768)
        setTheme(theme)
        setFontSize(fontSize)
        await i18n.changeLanguage(language)
        seed()

        render(withTranslations(<SupportChatSheet />))
        const sheet = await screen.findByTestId('support-chat-sheet')
        await settle(sheet)

        expect(sheet.getBoundingClientRect().width).toBe(380)
        expect(sheet.getBoundingClientRect().right).toBe(1024)
        expectNoHorizontalOverflow(sheet)
        expectNoHorizontalOverflow(screen.getByTestId('support-chat-thread'))

        // The thread scrolls; the composer and its note stay on screen.
        const send = screen.getByRole('button', {
          name: i18n.t('common:support.send'),
        })
        const sendBox = send.getBoundingClientRect()
        expect(sendBox.width).toBe(32)
        expect(sendBox.height).toBe(32)
        expect(sendBox.bottom).toBeLessThanOrEqual(768)
        const note = screen.getByText(i18n.t('common:support.disclosure'))
        expect(note.getBoundingClientRect().bottom).toBeLessThanOrEqual(768)

        // Retry sits beside its reason, inside the sheet.
        const retry = screen.getByRole('button', {
          name: i18n.t('common:support.retry'),
        })
        expect(retry.getBoundingClientRect().right).toBeLessThanOrEqual(
          sheet.getBoundingClientRect().right
        )
        await i18n.changeLanguage('en')
      }
    )
  }
)
