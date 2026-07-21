import type { ReactNode } from 'react'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSkillDetail } from '@/services/agent/skills'
import { SkillsPage } from './index'

const hookState = vi.hoisted(() => ({
  value: {} as {
    skills: AgentSkillDetail[]
    selected: AgentSkillDetail | null
    loading: boolean
    error: string | null
    load: ReturnType<typeof vi.fn>
    select: ReturnType<typeof vi.fn>
    setEnabled: ReturnType<typeof vi.fn>
    addCreated: ReturnType<typeof vi.fn>
    addImported: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  },
}))
const dialogOpen = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: object) => config,
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/hooks/useAgentSkills', () => ({
  useAgentSkills: () => hookState.value,
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    dialog: () => ({
      open: dialogOpen,
    }),
  }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode
    onSelect: () => void
  }) => <button onClick={onSelect}>{children}</button>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}))

const customSkill: AgentSkillDetail = {
  name: 'custom-skill',
  description: 'Custom skill',
  version: '1.0.0',
  requiresTools: [],
  requiresScripts: ['inspect.sh'],
  dangerous: true,
  platforms: null,
  enabled: true,
  compatible: true,
  reserved: false,
  unavailableReasons: [],
  error: null,
  body: '# Instructions',
}

describe('SkillsPage', () => {
  beforeEach(() => {
    dialogOpen.mockReset()
    hookState.value = {
      skills: [customSkill],
      selected: customSkill,
      loading: false,
      error: null,
      load: vi.fn(),
      select: vi.fn(),
      setEnabled: vi.fn(),
      addCreated: vi.fn().mockResolvedValue(undefined),
      addImported: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    }
  })

  it('offers folder import and in-app skill creation', async () => {
    dialogOpen.mockResolvedValue('/tmp/imported-skill')
    render(<SkillsPage />)

    expect(
      screen.getByRole('button', { name: 'common:createNewSkill' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText('common:fromFolder'))

    await waitFor(() =>
      expect(hookState.value.addImported).toHaveBeenCalledWith(
        '/tmp/imported-skill'
      )
    )

    fireEvent.click(screen.getByText('common:newSkill'))
    expect(
      screen.getByText('common:writeSkillInstructions')
    ).toBeInTheDocument()
  })

  it('shows skill details and confirms custom deletion', () => {
    render(<SkillsPage />)

    expect(
      screen.getByRole('heading', { name: 'Instructions' })
    ).toBeInTheDocument()
    expect(screen.getByText('common:dangerous')).toBeInTheDocument()
    expect(screen.getByText('common:skillEnabled')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('common:delete'))

    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByText('common:delete'))
    expect(hookState.value.remove).toHaveBeenCalledWith('custom-skill')
  })

  it('keeps malformed skills visible and hides bundled deletion', () => {
    const malformed: AgentSkillDetail = {
      ...customSkill,
      name: 'bundled-skill',
      reserved: true,
      enabled: false,
      compatible: false,
      error: 'Invalid SKILL.md',
      body: '',
    }
    hookState.value = {
      ...hookState.value,
      skills: [malformed],
      selected: malformed,
    }

    render(<SkillsPage />)

    expect(screen.getAllByText('Invalid SKILL.md')).toHaveLength(2)
    expect(screen.getByText('common:bundled')).toBeInTheDocument()
    expect(screen.getByText('common:skillDisabled')).toBeInTheDocument()
    expect(screen.getByText('common:incompatible')).toBeInTheDocument()
    expect(screen.queryByTitle('common:delete')).not.toBeInTheDocument()
  })

  it('updates the selected skill from its switch', async () => {
    hookState.value.setEnabled.mockResolvedValue(undefined)
    render(<SkillsPage />)

    fireEvent.click(screen.getByRole('switch', { name: 'common:enableSkill' }))

    await waitFor(() =>
      expect(hookState.value.setEnabled).toHaveBeenCalledWith(
        'custom-skill',
        false
      )
    )
  })
})
