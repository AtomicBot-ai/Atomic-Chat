import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Navigate: ({ to }: { to: string }) => (
    <div data-testid="redirect" data-to={to} />
  ),
}))
vi.mock('@/containers/onboarding/Onboarding', () => ({
  Onboarding: () => <div data-testid="onboarding" />,
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (select: (state: { providers: [] }) => unknown) =>
    select({ providers: [] }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: (select: (state: { threads: object }) => unknown) =>
    select({ threads: {} }),
}))

import { useOnboardingStore } from '@/stores/onboarding-store'

import { Route } from '../onboarding'

const OnboardingRoute = (Route as unknown as { component: React.ComponentType })
  .component

describe('setup screen route', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().reset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens for a fresh install', () => {
    render(<OnboardingRoute />)

    expect(screen.getByTestId('onboarding')).toBeInTheDocument()
  })

  it('sends a none install home, even in a forced build', () => {
    vi.stubGlobal('FORCE_ONBOARDING', true)
    vi.stubGlobal('FORCE_ONBOARDING_VARIANT', 'none')

    render(<OnboardingRoute />)

    expect(screen.queryByTestId('onboarding')).not.toBeInTheDocument()
    expect(screen.getByTestId('redirect')).toHaveAttribute('data-to', '/')
  })

  it('opens for a model-only install', () => {
    vi.stubGlobal('FORCE_ONBOARDING_VARIANT', 'model_only')

    render(<OnboardingRoute />)

    expect(screen.getByTestId('onboarding')).toBeInTheDocument()
  })

  it('keeps "Back to setup" open after a handoff', () => {
    useOnboardingStore.getState().begin('model_only', 'welcome')
    useOnboardingStore.getState().handOff('chat')
    localStorage.setItem(localStorageKey.setupCompleted, 'true')

    render(<OnboardingRoute />)

    expect(screen.getByTestId('onboarding')).toBeInTheDocument()
  })
})
