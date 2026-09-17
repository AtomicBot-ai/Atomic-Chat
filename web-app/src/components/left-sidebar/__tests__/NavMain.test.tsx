import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocation } from '@tanstack/react-router'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { NavMain } from '../NavMain'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    'children': React.ReactNode
    'to': string
    'aria-disabled'?: boolean
    'onClick'?: (event: React.MouseEvent) => void
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: vi.fn(),
  useNavigate: () => vi.fn(),
}))

// The sidebar primitives are stubbed, but they forward refs and props so the
// Plugins row can still act as a real Collapsible trigger.
vi.mock('@/components/ui/sidebar', async () => {
  const { forwardRef } = await import('react')
  return {
    SidebarMenu: ({ children }: { children: React.ReactNode }) => (
      <ul>{children}</ul>
    ),
    SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
      <li>{children}</li>
    ),
    SidebarMenuButton: forwardRef<HTMLDivElement, any>(
      ({ children, isActive, asChild, ...props }, ref) => (
        <div ref={ref} data-active={String(Boolean(isActive))} {...props}>
          {children}
        </div>
      )
    ),
    SidebarMenuSub: ({
      children,
      ...props
    }: {
      'children': React.ReactNode
      'data-testid'?: string
    }) => (
      <ul data-testid="plugins-submenu" {...props}>
        {children}
      </ul>
    ),
    SidebarMenuSubItem: ({ children }: { children: React.ReactNode }) => (
      <li>{children}</li>
    ),
    SidebarMenuSubButton: forwardRef<HTMLDivElement, any>(
      ({ children, isActive, asChild, ...props }, ref) => (
        <div ref={ref} data-active={String(Boolean(isActive))} {...props}>
          {children}
        </div>
      )
    ),
  }
})

vi.mock('@/components/animated-icon/plug', () => ({
  PlugIcon: () => null,
}))

vi.mock('@/components/animated-icon/cloud', () => ({
  CloudIcon: () => null,
}))

vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: () => <div data-testid="search-dialog" />,
}))

vi.mock('@/containers/dialogs/AddProjectDialog', () => ({
  default: () => null,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// Media generation is desktop-only; the flag is flipped per test so both the
// gated and the ungated sidebar can be checked from one file.
const platform = vi.hoisted(() => ({ mediaGeneration: true }))
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key === 'mediaGeneration'
          ? platform.mediaGeneration
          : target[key as keyof typeof target],
    }),
  }
})

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: () => true,
}))

vi.mock('@/hooks/useSearchDialog', () => ({
  useSearchDialog: () => ({ open: false, setOpen: vi.fn() }),
}))

vi.mock('@/hooks/useProjectDialog', () => ({
  useProjectDialog: (
    selector: (state: { open: boolean; setOpen: () => void }) => unknown
  ) => selector({ open: false, setOpen: vi.fn() }),
}))

vi.mock('@/hooks/useThreadManagement', () => ({
  useThreadManagement: () => ({ addFolder: vi.fn() }),
}))

// What the loaded image model can do; `null` means nothing is loaded.
const imageWorkflows = vi.hoisted(() => ({
  supported: null as string[] | null,
}))
vi.mock('@/hooks/useImageWorkflowAvailability', () => ({
  useImageWorkflowAvailability: () => ({
    isAvailable: (id: string) =>
      imageWorkflows.supported === null ||
      imageWorkflows.supported.includes(id),
  }),
}))

const IMAGE_WORKFLOW_LINKS: Array<[string, string]> = [
  ['images:workflow.create.label', '/images/'],
  ['images:workflow.transform.label', '/images/transform'],
  ['images:workflow.inpaint.label', '/images/inpaint'],
  ['images:workflow.extend.label', '/images/extend'],
  ['images:workflow.upscale.label', '/images/upscale'],
  ['images:workflow.reference.label', '/images/reference'],
  ['images:workflow.edit.label', '/images/edit'],
]

describe('NavMain', () => {
  beforeEach(() => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/' } as never)
    useLeftPanel.setState({ pluginsExpanded: false, imagesExpanded: false })
    platform.mediaGeneration = true
    imageWorkflows.supported = null
  })

  it('puts Images right after Models on desktop', () => {
    render(<NavMain />)

    const labels = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent?.trim())
    const models = labels.indexOf('common:modelHub')
    expect(models).toBeGreaterThanOrEqual(0)
    expect(labels[models + 1]).toBe('common:images')
    expect(screen.getByTestId('images-disclosure')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('hides Images where the platform has no media generation', () => {
    platform.mediaGeneration = false
    render(<NavMain />)

    expect(screen.queryByText('common:images')).not.toBeInTheDocument()
    expect(screen.getByText('common:modelHub')).toBeInTheDocument()
  })

  it('keeps the workflow list folded off the images page until the chevron is clicked', async () => {
    const user = userEvent.setup()
    render(<NavMain />)

    expect(screen.queryByTestId('images-submenu')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('images-disclosure'))

    const submenu = screen.getByTestId('images-submenu')
    for (const [label, href] of IMAGE_WORKFLOW_LINKS) {
      const link = screen.getByText(label).closest('a')
      expect(submenu).toContainElement(link)
      expect(link).toHaveAttribute('href', href)
    }
    expect(useLeftPanel.getState().imagesExpanded).toBe(true)
  })

  it('toggles Images from the whole row, not only the chevron glyph', async () => {
    const user = userEvent.setup()
    render(<NavMain />)

    await user.click(screen.getByText('common:images'))
    expect(screen.getByTestId('images-submenu')).toBeInTheDocument()
    expect(useLeftPanel.getState().imagesExpanded).toBe(true)

    await user.click(screen.getByText('common:images'))
    expect(screen.queryByTestId('images-submenu')).not.toBeInTheDocument()
    expect(useLeftPanel.getState().imagesExpanded).toBe(false)
  })

  it('opens the workflow list on the images route and highlights the current workflow', () => {
    vi.mocked(useLocation).mockReturnValue({
      pathname: '/images/inpaint',
    } as never)

    render(<NavMain />)

    expect(useLeftPanel.getState().imagesExpanded).toBe(true)
    expect(
      screen.getByText('images:workflow.inpaint.label').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
    expect(
      screen.getByText('images:workflow.create.label').closest('[data-active]')
    ).toHaveAttribute('data-active', 'false')
    // The list carries the highlight, not the group row.
    expect(
      screen.getByText('common:images').closest('[data-active]')
    ).toHaveAttribute('data-active', 'false')
  })

  it('highlights Create on /images/ and leaves the other workflows plain', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/images/' } as never)

    render(<NavMain />)
    expect(
      screen.getByText('images:workflow.create.label').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
    expect(
      screen
        .getByText('images:workflow.transform.label')
        .closest('[data-active]')
    ).toHaveAttribute('data-active', 'false')
  })

  it('disables the workflows the loaded model cannot run', () => {
    imageWorkflows.supported = ['create', 'transform']
    useLeftPanel.setState({ imagesExpanded: true })

    render(<NavMain />)

    expect(
      screen.getByText('images:workflow.transform.label').closest('a')
    ).not.toHaveAttribute('aria-disabled')
    const inpaint = screen
      .getByText('images:workflow.inpaint.label')
      .closest('a')
    expect(inpaint).toHaveAttribute('aria-disabled', 'true')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    inpaint?.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
  })

  it('shows every section on the unified sidebar', () => {
    render(<NavMain />)

    expect(screen.getByText('common:newChat')).toBeInTheDocument()
    expect(screen.getByText('common:modelHub')).toBeInTheDocument()
    expect(screen.getByText('common:cloud')).toBeInTheDocument()
    expect(screen.getByText('common:plugins')).toBeInTheDocument()
    expect(screen.getByText('common:projects.new')).toBeInTheDocument()
    expect(screen.getByText('common:launch')).toBeInTheDocument()
    expect(screen.getByText('common:api')).toBeInTheDocument()
    expect(screen.queryByText('common:newTask')).not.toBeInTheDocument()
  })

  it('keeps Connectors and Skills tucked inside the collapsed Plugins group', () => {
    render(<NavMain />)

    expect(screen.queryByText('common:connectors')).not.toBeInTheDocument()
    expect(screen.queryByText('common:skills')).not.toBeInTheDocument()
  })

  it('reveals Connectors and Skills as Plugins sub-items when expanded', async () => {
    const user = userEvent.setup()
    render(<NavMain />)

    await user.click(screen.getByText('common:plugins'))

    const submenu = screen
      .getAllByTestId('plugins-submenu')
      .find((element) => element.textContent?.includes('common:connectors'))
    expect(submenu).toContainElement(screen.getByText('common:connectors'))
    expect(submenu).toContainElement(screen.getByText('common:skills'))
  })

  it('expands the Plugins group and highlights Connectors on its route', () => {
    vi.mocked(useLocation).mockReturnValue({
      pathname: '/connectors/',
    } as never)
    render(<NavMain />)

    expect(useLeftPanel.getState().pluginsExpanded).toBe(true)
    expect(
      screen.getByText('common:connectors').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
  })

  it('highlights the Plugins group itself when collapsed on a child route', async () => {
    const user = userEvent.setup()
    vi.mocked(useLocation).mockReturnValue({ pathname: '/skills/' } as never)
    render(<NavMain />)

    await user.click(screen.getByText('common:plugins'))

    expect(
      screen.getByText('common:plugins').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
  })

  it('highlights Cloud on the cloud route', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/cloud/' } as never)

    render(<NavMain />)

    expect(
      screen.getByText('common:cloud').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
  })

  it('highlights Integrations on the launch route', () => {
    vi.mocked(useLocation).mockReturnValue({ pathname: '/launch/' } as never)

    render(<NavMain />)

    expect(
      screen.getByText('common:launch').closest('[data-active]')
    ).toHaveAttribute('data-active', 'true')
  })
})
