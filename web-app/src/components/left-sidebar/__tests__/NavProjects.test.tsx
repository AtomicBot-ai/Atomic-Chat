import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useParams } from '@tanstack/react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { ThreadFolder } from '@/services/projects/types'
import { NavProjects } from '../NavProjects'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: React.ReactNode
    to: string
    params?: Record<string, string>
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce(
        (href, [key, value]) => href.replace(`$${key}`, value),
        to
      )}
      {...props}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useParams: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const folders: ThreadFolder[] = [
  { id: 'p-1', name: 'QA Project', updated_at: 1 },
  { id: 'p-2', name: 'Research', updated_at: 2 },
]

vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({
    folders,
    updateFolder: vi.fn(),
    reorderFolders: vi.fn(),
  }),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: (state: unknown) => unknown) =>
    selector({ threads: {}, currentThreadId: undefined }),
}))

vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: (selector: (state: unknown) => unknown) =>
    selector({ projectExpanded: {}, setProjectExpanded: vi.fn() }),
}))

vi.mock('@/hooks/useSidebarLists', () => ({
  useSidebarLists: (selector: (state: unknown) => unknown) =>
    selector({ collapsed: { projects: false }, toggleGroup: vi.fn() }),
}))

vi.mock('@/containers/ThreadList', () => ({ default: () => null }))
vi.mock('@/containers/dialogs/AddProjectDialog', () => ({
  default: () => null,
}))
vi.mock('@/containers/dialogs/DeleteProjectDialog', () => ({
  DeleteProjectDialog: () => null,
}))
vi.mock('@/components/animated-icon/folders', () => ({
  FoldersIcon: () => <svg aria-hidden />,
}))

const openPage = (params: Record<string, string>) =>
  vi.mocked(useParams).mockReturnValue(params as never)

const projectRow = (name: string) => screen.getByText(name).closest('a')

const renderProjects = () =>
  render(
    <SidebarProvider>
      <NavProjects onCreate={vi.fn()} />
    </SidebarProvider>
  )

describe('NavProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openPage({})
  })

  it('highlights the project whose page is open, like an open chat row', () => {
    openPage({ projectId: 'p-1' })
    renderProjects()

    const open = projectRow('QA Project')
    expect(open).toHaveAttribute('href', '/project/p-1')
    expect(open).toHaveAttribute('data-active', 'true')
    // ThreadList gives an open chat row this same background.
    expect(open).toHaveClass('data-[active=true]:bg-sidebar-foreground/15')
    expect(projectRow('Research')).toHaveAttribute('data-active', 'false')
  })

  it('highlights no project away from a project page', () => {
    openPage({ threadId: 't-1' })
    renderProjects()

    expect(projectRow('QA Project')).toHaveAttribute('data-active', 'false')
    expect(projectRow('Research')).toHaveAttribute('data-active', 'false')
  })
})
