import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSkill, AgentSkillDetail } from '@/services/agent/skills'

/**
 * Task 28 (decision D36, as amended by the user on 2026-09-14): every skill -
 * bundled with Radium, from Anthropic, written in Radium or uploaded - goes
 * through Allow / Preview / Cancel before it can be switched on. These pin the
 * Skills page's side of that.
 */

const hook = vi.hoisted(() => ({
  state: {
    skills: [] as AgentSkill[],
    selected: null as AgentSkillDetail | null,
    loading: false,
    error: null as string | null,
    load: vi.fn(),
    select: vi.fn(),
    setEnabled: vi.fn(),
    approve: vi.fn(),
    addCreated: vi.fn(),
    addImported: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    exportSkill: vi.fn(),
  },
}))

const services = vi.hoisted(() => ({ getAgentSkill: vi.fn() }))

vi.mock('@/hooks/useAgentSkills', () => ({
  useAgentSkills: () => hook.state,
}))

vi.mock('@/services/agent/skills', () => ({
  getAgentSkill: services.getAgentSkill,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock('@/containers/RenderMarkdown', () => ({
  RenderMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}))

// The upload dialog is exercised elsewhere; here it only needs to hand the page
// an uploaded path.
vi.mock('@/containers/AgentSkillUploadDialog', () => ({
  AgentSkillUploadDialog: ({
    open,
    onUpload,
  }: {
    open: boolean
    onUpload: (path: string) => Promise<void>
  }) =>
    open ? (
      <button
        type="button"
        onClick={() => void onUpload('C:/skills/added.skill')}
      >
        upload-now
      </button>
    ) : null,
}))

import { SkillsPage } from '../index'

function skill(name: string, overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    name,
    description: `${name} description`,
    version: '1.0.0',
    requiresTools: ['os.shell.run'],
    requiresScripts: [],
    dangerous: false,
    platforms: null,
    enabled: false,
    compatible: true,
    reserved: false,
    unavailableReasons: [],
    needsReview: false,
    error: null,
    ...overrides,
  }
}

function detail(
  name: string,
  overrides: Partial<AgentSkillDetail> = {}
): AgentSkillDetail {
  return {
    ...skill(name, { needsReview: true }),
    body: `Instructions for ${name}.`,
    files: [],
    ...overrides,
  }
}

const switchFor = (name: string) =>
  screen
    .getByText(name)
    .closest('div.rounded-lg')!
    .querySelector('button[role="switch"]') as HTMLElement

describe('SkillsPage review before use', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hook.state.skills = [
      skill('docker', { reserved: true, needsReview: true }),
      skill('reviewed-skill', { needsReview: false }),
    ]
    services.getAgentSkill.mockImplementation(async (name: string) =>
      detail(name)
    )
    hook.state.approve.mockResolvedValue(undefined)
    hook.state.setEnabled.mockResolvedValue(undefined)
  })

  it('asks for a review before switching on a skill, even a bundled one', async () => {
    const user = userEvent.setup()
    render(<SkillsPage />)

    await user.click(switchFor('docker'))

    expect(
      await screen.findByText('review:skillTitle:{"name":"docker"}')
    ).toBeInTheDocument()
    expect(hook.state.setEnabled).not.toHaveBeenCalled()
    expect(hook.state.approve).not.toHaveBeenCalled()
  })

  it('switches the skill on only when Allow is chosen', async () => {
    const user = userEvent.setup()
    render(<SkillsPage />)

    await user.click(switchFor('docker'))
    await user.click(
      await screen.findByRole('button', { name: 'review:allow' })
    )

    expect(hook.state.approve).toHaveBeenCalledWith('docker')
    await waitFor(() =>
      expect(
        screen.queryByText('review:skillTitle:{"name":"docker"}')
      ).not.toBeInTheDocument()
    )
  })

  it('leaves the skill off when Cancel is chosen', async () => {
    const user = userEvent.setup()
    render(<SkillsPage />)

    await user.click(switchFor('docker'))
    await user.click(
      await screen.findByRole('button', { name: 'review:cancel' })
    )

    await waitFor(() =>
      expect(
        screen.queryByText('review:skillTitle:{"name":"docker"}')
      ).not.toBeInTheDocument()
    )
    // The skill is still shown as off.
    expect(switchFor('docker')).toHaveAttribute('aria-checked', 'false')
    expect(hook.state.approve).not.toHaveBeenCalled()
    expect(hook.state.setEnabled).not.toHaveBeenCalled()
  })

  it('shows the files that come with the skill in Preview', async () => {
    const user = userEvent.setup()
    services.getAgentSkill.mockResolvedValue(
      detail('docker', {
        files: [
          { path: 'scripts/check.sh', content: 'docker ps', truncated: false },
        ],
      })
    )
    render(<SkillsPage />)

    await user.click(switchFor('docker'))
    await user.click(
      await screen.findByRole('button', { name: 'review:preview' })
    )

    const preview = screen.getByRole('region', { name: 'review:previewTitle' })
    expect(preview).toHaveTextContent('scripts/check.sh')
    expect(preview).toHaveTextContent('docker ps')
  })

  it('switches a reviewed skill on and off directly', async () => {
    const user = userEvent.setup()
    render(<SkillsPage />)

    await user.click(switchFor('reviewed-skill'))

    expect(hook.state.setEnabled).toHaveBeenCalledWith('reviewed-skill', true)
    expect(
      screen.queryByText('review:skillTitle:{"name":"reviewed-skill"}')
    ).not.toBeInTheDocument()
  })

  it('opens the review straight after a skill is uploaded', async () => {
    const user = userEvent.setup()
    hook.state.addImported.mockResolvedValue(detail('added'))
    render(<SkillsPage />)

    await user.click(
      screen.getByRole('button', { name: /common:createNewSkill/ })
    )
    await user.click(
      await screen.findByRole('menuitem', { name: /common:uploadASkill/ })
    )
    await user.click(await screen.findByRole('button', { name: 'upload-now' }))

    expect(
      await screen.findByText('review:skillTitle:{"name":"added"}')
    ).toBeInTheDocument()
    expect(hook.state.approve).not.toHaveBeenCalled()
  })
})
