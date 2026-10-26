import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  createConversation: vi.fn(),
  sendMessage: vi.fn(),
}))
vi.mock('@/services/support/client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/support/client')>()
  return { ...actual, ...client }
})

vi.mock('@/services/support/diagnostics', () => ({
  collectSupportMeta: vi.fn(async () => ({ app_version: 'test' })),
  hashSupportMeta: () => 'hash',
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

import { SupportApiError } from '@/services/support/client'
import { useSupportChatStore } from '@/stores/support-chat-store'
import { SupportChatSheet } from '../SupportChatSheet'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const openSheet = () => {
  useSupportChatStore.setState({ sheetOpen: true })
  return render(<SupportChatSheet />)
}

const composer = () =>
  screen.getByRole('textbox', { name: 'common:support.inputLabel' })

const sendButton = () =>
  screen.getByRole('button', { name: 'common:support.send' })

describe('SupportChatSheet', () => {
  beforeEach(() => {
    client.createConversation.mockReset()
    client.sendMessage.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    useSupportChatStore.setState({
      conversationId: 'c-1',
      token: 'tok',
      messages: [],
      lastSeq: 0,
      lastReadSeq: 0,
      metaHash: 'hash',
      sheetOpen: false,
    })
  })

  it('renders nothing while closed', () => {
    render(<SupportChatSheet />)
    expect(screen.queryByTestId('support-chat-sheet')).not.toBeInTheDocument()
  })

  it('greets, explains what is attached and starts with Send disabled', () => {
    openSheet()

    expect(screen.getByText('common:support.title')).toBeInTheDocument()
    expect(screen.getByText('common:support.subtitle')).toBeInTheDocument()
    expect(screen.getByText('common:support.greeting')).toBeInTheDocument()
    expect(screen.getByText('common:support.disclosure')).toBeInTheDocument()
    expect(composer()).toHaveAttribute(
      'placeholder',
      'common:support.placeholder'
    )
    expect(sendButton()).toBeDisabled()
    expect(composer()).toHaveFocus()
  })

  it('sends on Enter, shows the message pending, then sent', async () => {
    const user = userEvent.setup()
    const answer = deferred<{ seq: number; created_at: string }>()
    client.sendMessage.mockReturnValue(answer.promise)
    openSheet()

    await user.type(composer(), 'My model will not load')
    expect(sendButton()).toBeEnabled()
    await user.keyboard('{Enter}')

    expect(composer()).toHaveValue('')
    const bubble = screen.getByText('My model will not load').closest('li')!
    expect(bubble).toHaveAttribute('data-status', 'pending')
    expect(
      within(bubble).getByText('common:support.sending')
    ).toBeInTheDocument()

    await act(async () => {
      answer.resolve({ seq: 1, created_at: new Date().toISOString() })
    })

    await waitFor(() =>
      expect(
        screen.getByText('My model will not load').closest('li')
      ).toHaveAttribute('data-status', 'sent')
    )
    expect(screen.queryByText('common:support.sending')).not.toBeInTheDocument()
    expect(client.sendMessage).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ text: 'My model will not load' })
    )
  })

  it('keeps Shift+Enter as a new line', async () => {
    const user = userEvent.setup()
    openSheet()

    await user.type(composer(), 'first{Shift>}{Enter}{/Shift}second')

    expect(composer()).toHaveValue('first\nsecond')
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it('shows a failed message with Retry, which sends it again', async () => {
    const user = userEvent.setup()
    client.sendMessage
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ seq: 2, created_at: new Date().toISOString() })
    openSheet()

    await user.type(composer(), 'Hello?')
    await user.click(sendButton())

    const failed = await screen.findByText('common:support.notSent')
    const row = failed.closest('li')!
    expect(row).toHaveAttribute('data-status', 'failed')

    await user.click(
      within(row).getByRole('button', { name: 'common:support.retry' })
    )

    await waitFor(() =>
      expect(screen.getByText('Hello?').closest('li')).toHaveAttribute(
        'data-status',
        'sent'
      )
    )
    const [first, second] = client.sendMessage.mock.calls.map(
      (call) => call[1].client_id
    )
    expect(second).toBe(first)
  })

  it('says so when the relay rate-limits a message', async () => {
    const user = userEvent.setup()
    client.sendMessage.mockRejectedValueOnce(new SupportApiError(429, 'slow'))
    openSheet()

    await user.type(composer(), 'Spam?{Enter}')

    expect(
      await screen.findByText('common:support.rateLimited')
    ).toBeInTheDocument()
  })

  it('labels the team replies and puts them on the left', () => {
    useSupportChatStore.getState().applyServerMessages([
      {
        id: 't-1',
        seq: 1,
        author: 'team',
        text: 'Try the upstream engine',
        created_at: '2026-10-26T10:00:00Z',
        edited_at: null,
        deleted: false,
      },
    ])
    openSheet()

    const row = screen.getByText('Try the upstream engine').closest('li')!
    expect(row).toHaveClass('items-start')
    expect(within(row).getByText('common:support.teamName')).toBeInTheDocument()
    expect(within(row).getByText(/\d/, { selector: 'time' })).toHaveAttribute(
      'datetime',
      '2026-10-26T10:00:00Z'
    )
  })

  it('closes from its own close button', async () => {
    const user = userEvent.setup()
    openSheet()

    await user.click(
      screen.getByRole('button', { name: 'common:support.close' })
    )

    expect(useSupportChatStore.getState().sheetOpen).toBe(false)
  })
})
