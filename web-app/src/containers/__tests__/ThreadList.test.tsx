import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useParams } from '@tanstack/react-router'
import ThreadList from '../ThreadList'
import type { MessagesService } from '@/services/messages/types'
import { seedServiceHub } from '@/test/service-hub'

// Render Link as a plain anchor, forwarding any extra props (e.g. the
// data-active / className the sidebar button merges onto it).
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params, className, ...props }: any) => (
    <a
      href={typeof to === 'string' ? to : '#'}
      className={className}
      {...props}
    >
      {children}
    </a>
  ),
  useParams: vi.fn(),
}))

// Lightweight sidebar mock that surfaces `isActive` as `data-active` so the
// test asserts the real wiring without pulling in the full sidebar context.
vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ isMobile: false }),
  SidebarMenuItem: ({ children, className }: any) => (
    <li className={className}>{children}</li>
  ),
  SidebarMenuSubItem: ({ children, className }: any) => (
    <li className={className}>{children}</li>
  ),
  SidebarMenuButton: ({ children, isActive }: any) => (
    <div data-testid="thread-button" data-active={String(!!isActive)}>
      {children}
    </div>
  ),
  SidebarMenuSubButton: ({ children, isActive }: any) => (
    <div data-testid="thread-button" data-active={String(!!isActive)}>
      {children}
    </div>
  ),
  SidebarMenuAction: ({ children }: any) => (
    <button type="button">{children}</button>
  ),
}))

// Dropdown menu and dialogs are not under test — collapse them to passthroughs.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: any) => <div>{children}</div>
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: Pass,
    DropdownMenuSeparator: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSubTrigger: Pass,
  }
})

vi.mock('@/containers/dialogs', () => ({
  RenameThreadDialog: () => null,
  DeleteThreadDialog: () => null,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
  LOCAL_LLAMACPP_PROVIDER: 'llamacpp-upstream',
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: any) =>
    selector({
      deleteThread: vi.fn(),
      renameThread: vi.fn(),
      updateThread: vi.fn(),
    }),
}))

// Mirror the real store: a stable state object backed by actual storage. Handing
// out fresh closures per render would retrigger the row's fetch effect.
vi.mock('@/hooks/useMessages', () => {
  const byThread = new Map<string, unknown[]>()
  const state = {
    getMessages: (threadId: string) => byThread.get(threadId) ?? [],
    setMessages: (threadId: string, messages: unknown[]) => {
      byThread.set(threadId, messages)
    },
    reset: () => byThread.clear(),
  }
  return { useMessages: (selector: any) => selector(state), __messages: state }
})

vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagementStore: (selector: any) =>
    selector({ getFolderById: vi.fn(), folders: [] }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@janhq/core', () => ({}))

const threads: Thread[] = [
  { id: 'thread-1', title: 'First chat', updated: 2 },
  { id: 'thread-2', title: 'Second chat', updated: 1 },
]

const PREVIEW_TEXT = 'Which quant fits my GPU?'

const previewMessages = [
  {
    role: 'user',
    content: [{ type: 'text', text: { value: PREVIEW_TEXT } }],
  },
]

let fetchMessages: ReturnType<typeof vi.fn>

describe('ThreadList active highlight', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { __messages } = (await import('@/hooks/useMessages')) as unknown as {
      __messages: { reset: () => void }
    }
    __messages.reset()
    fetchMessages = vi.fn().mockResolvedValue(previewMessages)
    seedServiceHub({
      messages: {
        fetchMessages,
      } as unknown as MessagesService,
    })
  })

  it('marks the open thread active and the others inactive', async () => {
    vi.mocked(useParams).mockReturnValue({ threadId: 'thread-1' } as never)

    await act(async () => {
      render(<ThreadList threads={threads} />)
    })

    const activeButton = screen
      .getByText('First chat')
      .closest('[data-testid="thread-button"]')
    const inactiveButton = screen
      .getByText('Second chat')
      .closest('[data-testid="thread-button"]')

    expect(activeButton).toHaveAttribute('data-active', 'true')
    expect(inactiveButton).toHaveAttribute('data-active', 'false')
  })

  it('marks no thread active when not on a thread route', async () => {
    vi.mocked(useParams).mockReturnValue({} as never)

    await act(async () => {
      render(<ThreadList threads={threads} />)
    })

    screen
      .getAllByTestId('thread-button')
      .forEach((button) =>
        expect(button).toHaveAttribute('data-active', 'false')
      )
  })

  it('highlights the open thread card inside a project', async () => {
    vi.mocked(useParams).mockReturnValue({ threadId: 'thread-2' } as never)

    await act(async () => {
      render(<ThreadList threads={threads} currentProjectId="project-1" />)
    })

    const activeCard = screen.getByText('Second chat').closest('a')
    const inactiveCard = screen.getByText('First chat').closest('a')

    // Selected card gets the full `bg-secondary` accent (the project's
    // selected convention); match the exact token so the base
    // `dark:bg-secondary/20` doesn't give a false positive.
    expect(activeCard?.className.split(' ')).toContain('bg-secondary')
    expect(inactiveCard?.className.split(' ')).not.toContain('bg-secondary')
  })

  it('does not hydrate messages for history rows', async () => {
    vi.mocked(useParams).mockReturnValue({} as never)

    await act(async () => {
      render(<ThreadList threads={threads} />)
    })

    // History rows render a title only, so fetching their message history would
    // be one pointless round-trip per row.
    expect(screen.queryByText(PREVIEW_TEXT)).not.toBeInTheDocument()
    expect(fetchMessages.mock.calls).toEqual([])
  })

  it('hydrates messages for project cards, which render a preview', async () => {
    vi.mocked(useParams).mockReturnValue({} as never)

    await act(async () => {
      render(<ThreadList threads={threads} currentProjectId="project-1" />)
    })

    expect(screen.getAllByText(PREVIEW_TEXT)).toHaveLength(threads.length)
    expect(fetchMessages.mock.calls.flat()).toEqual(['thread-1', 'thread-2'])
  })

  it('does not render chat type icons', async () => {
    vi.mocked(useParams).mockReturnValue({} as never)

    await act(async () => {
      render(<ThreadList threads={threads} />)
    })

    expect(
      screen.queryByLabelText('chat:threadType.chat')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText('chat:threadType.agent')
    ).not.toBeInTheDocument()
  })
})
