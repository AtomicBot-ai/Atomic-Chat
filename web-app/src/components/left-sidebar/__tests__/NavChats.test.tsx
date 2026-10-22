import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarProvider } from '@/components/ui/sidebar'
import { NavChats } from '../NavChats'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

type TestThread = { id: string; title: string; isFavorite?: boolean }
let threads: TestThread[] = []

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: (state: unknown) => unknown) =>
    selector({
      threads: Object.fromEntries(threads.map((t) => [t.id, t])),
      getFilteredThreads: () => threads,
      deleteThread: vi.fn(),
    }),
}))

vi.mock('@/hooks/useSidebarLists', () => ({
  useSidebarLists: (selector: (state: unknown) => unknown) =>
    selector({ collapsed: { recents: false }, toggleGroup: vi.fn() }),
}))

vi.mock('@/containers/ThreadList', () => ({
  default: ({ threads }: { threads: TestThread[] }) => (
    <>
      {threads.map((thread) => (
        <span key={thread.id}>{thread.title}</span>
      ))}
    </>
  ),
}))
vi.mock('@/containers/dialogs/DeleteAllThreadsDialog', () => ({
  DeleteAllThreadsDialog: () => null,
}))

const renderChats = () =>
  render(
    <SidebarProvider>
      <NavChats />
    </SidebarProvider>
  )

describe('NavChats', () => {
  beforeEach(() => {
    threads = []
  })

  it('shows Recents as a plain label, with only "+", while it is empty', () => {
    renderChats()

    expect(screen.getByText('common:recents').tagName).toBe('SPAN')
    expect(screen.queryByRole('button', { name: 'common:recents' })).toBeNull()
    expect(screen.queryByText('More')).toBeNull()
    // "+" takes the corner the menu would otherwise hold.
    expect(
      screen.getByRole('button', { name: 'common:newChat' })
    ).not.toHaveClass('right-10')
  })

  it('folds Recents and offers its menu once a chat is in it', () => {
    threads = [
      { id: 't-1', title: 'Design review' },
      { id: 't-2', title: 'Pinned chat', isFavorite: true },
    ]
    renderChats()

    expect(
      screen.getByRole('button', { name: 'common:recents' })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('More')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'common:newChat' })).toHaveClass(
      'right-10'
    )
    expect(screen.getByText('Design review')).toBeInTheDocument()
    // Pinned chats live in their own group above.
    expect(screen.queryByText('Pinned chat')).toBeNull()
  })
})
