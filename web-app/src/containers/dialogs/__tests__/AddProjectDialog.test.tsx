import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

import AddProjectDialog from '../AddProjectDialog'
import { defaultAssistant, useAssistant } from '@/hooks/useAssistant'
import { useChatExecStatus } from '@/hooks/useChatExecStatus'
import { UNSUPPORTED_CHAT_EXEC_STATUS } from '@/services/chat-exec/types'
import { seedServiceHub } from '@/test/service-hub'

const researcher = {
  ...defaultAssistant,
  id: 'researcher',
  name: 'Researcher',
  avatar: undefined,
}

const renderDialog = (props: Partial<Parameters<typeof AddProjectDialog>[0]>) =>
  render(
    <AddProjectDialog
      open
      onOpenChange={vi.fn()}
      editingKey={null}
      onSave={vi.fn()}
      {...props}
    />
  )

describe('AddProjectDialog assistant', () => {
  beforeEach(() => {
    seedServiceHub({
      projects: { getProjects: vi.fn().mockResolvedValue([]) } as never,
    })
    useChatExecStatus.setState({ status: UNSUPPORTED_CHAT_EXEC_STATUS })
    useAssistant.setState({
      assistants: [defaultAssistant, researcher],
      defaultAssistantId: 'researcher',
    })
  })

  it('starts a new project with the default assistant from Settings', () => {
    renderDialog({})

    expect(screen.getByText('Researcher')).toBeInTheDocument()
    expect(
      screen.queryByText('projects.addProjectDialog.selectAssistant')
    ).not.toBeInTheDocument()
  })

  it('shows the initial of an assistant without an avatar in the picker', () => {
    renderDialog({})

    const trigger = screen.getByText('Researcher').closest('button')!
    expect(
      trigger.querySelector('[data-slot="avatar-fallback"]')
    ).toHaveTextContent(/^R$/)
  })

  it('leaves the choice empty when the default assistant no longer exists', () => {
    useAssistant.setState({ defaultAssistantId: 'deleted' })

    renderDialog({})

    expect(
      screen.getByText('projects.addProjectDialog.selectAssistant')
    ).toBeInTheDocument()
  })

  it("keeps an edited project's own choice, no assistant included", () => {
    renderDialog({
      editingKey: 'p1',
      initialData: { id: 'p1', name: 'P1', updated_at: 0 },
    })

    expect(
      screen.getByText('projects.addProjectDialog.selectAssistant')
    ).toBeInTheDocument()
    expect(screen.queryByText('Researcher')).not.toBeInTheDocument()
  })
})
