import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localStorageKey } from '@/constants/localStorage'
import { SETUP_COMPLETED_EVENT } from '@/hooks/useSetupCompleted'

const mocks = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  useSearch: () => mocks.search,
  Navigate: ({ to }: { to: string }) => (
    <div data-testid="redirect" data-to={to} />
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/containers/ChatInput', () => ({
  default: () => <div data-testid="chat-input" />,
}))
vi.mock('@/containers/HeaderPage', () => ({ default: () => null }))
vi.mock('@/containers/AgentWorkspaceLayout', () => ({
  AgentWorkspaceLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('@/hooks/useTools', () => ({ useTools: () => undefined }))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))
vi.mock('@/services/agent/tauri', () => ({
  resolveAgentWorkspaceRoot: vi.fn(),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({ providers: [] }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: () => ({ threads: {}, setCurrentThreadId: vi.fn() }),
}))
vi.mock('@/hooks/useAgentMode', () => ({
  useAgentMode: () => undefined,
}))

import { useOnboardingStore } from '@/stores/onboarding-store'

import { Route } from '../index'

const Index = (Route as unknown as { component: React.ComponentType })
  .component

describe('home route onboarding gate', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().reset()
    mocks.search = {}
  })

  it('sends a first-run user to the setup screen', () => {
    render(<Index />)

    expect(screen.getByTestId('redirect')).toHaveAttribute(
      'data-to',
      '/onboarding'
    )
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument()
  })

  // Leaving setup lands on `/` with whatever search it already had, so only
  // the completion event can keep the route from sending the user back.
  it('shows the chat once setup completes on the same route', () => {
    render(<Index />)

    act(() => {
      localStorage.setItem(localStorageKey.setupCompleted, 'true')
      window.dispatchEvent(new Event(SETUP_COMPLETED_EVENT))
    })

    expect(screen.queryByTestId('redirect')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
  })

  // The backend step relaunches the app halfway through setup.
  it('goes back to a run that was on screen when the app closed', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    useOnboardingStore.getState().begin('full', 'backend')

    render(<Index />)

    expect(screen.getByTestId('redirect')).toHaveAttribute(
      'data-to',
      '/onboarding'
    )
  })

  it('greets an empty chat with the logo above the question', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    render(<Index />)

    const logo = screen.getByTestId('lazy-atomic-logo')
    const question = screen.getByRole('heading', { level: 1 })
    expect(question).toHaveTextContent('chat:description')
    expect(
      logo.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
