import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSkill } from '@/services/agent/skills'
import { AgentSkillSlashMenu } from './AgentSkillSlashMenu'

const pdfSkill: AgentSkill = {
  name: 'pdf',
  description: 'Read PDF documents',
  version: '1.0.0',
  requiresTools: [],
  requiresScripts: [],
  dangerous: false,
  platforms: null,
  enabled: true,
  compatible: true,
  reserved: true,
  unavailableReasons: [],
  error: null,
}

describe('AgentSkillSlashMenu', () => {
  it('renders the menu only when open', () => {
    const props = {
      skills: [pdfSkill],
      selectedSkill: null,
      activeIndex: 0,
      loading: false,
      onSelect: vi.fn(),
      onRemove: vi.fn(),
      onActiveIndexChange: vi.fn(),
    }
    const { rerender } = render(<AgentSkillSlashMenu {...props} open={false} />)

    expect(screen.queryByTestId('agent-skill-slash-menu')).toBeNull()

    rerender(<AgentSkillSlashMenu {...props} open />)
    expect(screen.getByRole('option', { name: /pdf/i })).toBeInTheDocument()
  })

  it('selects a skill with the mouse', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentSkillSlashMenu
        skills={[pdfSkill]}
        selectedSkill={null}
        activeIndex={0}
        loading={false}
        open
        onSelect={onSelect}
        onRemove={vi.fn()}
        onActiveIndexChange={vi.fn()}
      />
    )

    await user.click(screen.getByRole('option', { name: /pdf/i }))

    expect(onSelect).toHaveBeenCalledWith(pdfSkill)
  })

  it('removes the selected skill chip', async () => {
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentSkillSlashMenu
        skills={[]}
        selectedSkill={pdfSkill}
        activeIndex={0}
        loading={false}
        open={false}
        onSelect={vi.fn()}
        onRemove={onRemove}
        onActiveIndexChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('agent-skill-chip')).toBeInTheDocument()
    await user.click(screen.getByRole('button'))

    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
