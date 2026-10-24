import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'

import { useServerSetup } from '@/hooks/useServerSetup'
import { useOnboardingStore } from '@/stores/onboarding-store'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import {
  connectAgentHint,
  finishGuide,
  pickAgentHint,
  SetupGuideHint,
} from '../SetupGuideHint'

const region = () =>
  screen.queryByRole('region', { name: 'onboarding-server:guide.label' })
const guideEvents = () =>
  vi
    .mocked(posthog.capture)
    .mock.calls.filter(([name]) => name === 'onboarding_guide')
    .map(([, props]) => props)

/** A run handed off to the server, its chat model still downloading. */
function handOff(destination: 'endpoint' | 'agents') {
  const store = useOnboardingStore.getState()
  store.begin('full', 'server')
  store.enqueue({
    key: 'chat',
    kind: 'chat',
    title: 'Qwen3.5 4B',
    taskId: 'Qwen3.5-4B-Q4_K_M',
    phase: 'running',
  })
  store.handOff(destination)
}

describe('setup guide hints', () => {
  beforeEach(() => {
    vi.mocked(posthog.capture).mockClear()
    navigate.mockClear()
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useServerSetup.setState({ setupDone: false, endpointConfigured: false })
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('shows only the hint the guide is on, and none without a guide', () => {
    const { rerender } = render(<SetupGuideHint path="endpoint" hint={0} />)
    expect(region()).toBeNull()

    act(() => handOff('endpoint'))
    rerender(<SetupGuideHint path="endpoint" hint={1} />)
    expect(region()).toBeNull()

    rerender(<SetupGuideHint path="endpoint" hint={0} />)
    expect(region()).toHaveTextContent('onboarding-server:guide.settings.title')
  })

  it('comes into view when it is the current one', () => {
    handOff('agents')
    render(<SetupGuideHint path="agents" hint={0} />)

    expect(region()).toBeInTheDocument()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'nearest' })
    )
  })

  it('says the model is downloading on the settings hints, not on picking a tool', () => {
    handOff('agents')
    const { unmount } = render(<SetupGuideHint path="agents" hint={0} />)
    expect(
      screen.queryByText('onboarding-server:guide.downloading')
    ).not.toBeInTheDocument()
    unmount()

    act(() =>
      useOnboardingStore.getState().setGuide({ path: 'agents', hint: 1 })
    )
    render(<SetupGuideHint path="agents" hint={1} />)
    expect(
      screen.getByText('onboarding-server:guide.downloading')
    ).toBeInTheDocument()

    act(() => useOnboardingStore.getState().setJobPhase('chat', 'done'))
    expect(
      screen.queryByText('onboarding-server:guide.downloading')
    ).not.toBeInTheDocument()
  })

  it('offers Next hint on the endpoint path up to the last hint only', () => {
    handOff('endpoint')
    act(() =>
      useOnboardingStore.getState().setGuide({ path: 'endpoint', hint: 2 })
    )
    render(<SetupGuideHint path="endpoint" hint={2} />)

    expect(region()).toHaveTextContent('onboarding-server:guide.start.title')
    expect(
      screen.queryByRole('button', { name: 'onboarding-server:guide.next' })
    ).not.toBeInTheDocument()
  })

  it('Skip guide ends the hints and closes the download panel', () => {
    handOff('endpoint')
    render(<SetupGuideHint path="endpoint" hint={0} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-server:guide.skip' })
    )

    expect(region()).toBeNull()
    expect(useOnboardingStore.getState()).toMatchObject({
      guide: null,
      panelDismissed: true,
    })
    expect(guideEvents()).toEqual([
      expect.objectContaining({
        guide_path: 'endpoint',
        hint: 0,
        guide_action: 'skip',
      }),
    ])
  })

  it('follows an agent into the setup guide, or ends for one set up already or elsewhere', () => {
    handOff('agents')
    pickAgentHint('connect')
    expect(useOnboardingStore.getState().guide).toEqual({
      path: 'agents',
      hint: 1,
    })
    // Configure from the setup guide's own list is not "Pick your tool".
    pickAgentHint('end')
    expect(useOnboardingStore.getState().guide).toEqual({
      path: 'agents',
      hint: 1,
    })

    act(() =>
      useOnboardingStore.getState().setGuide({ path: 'agents', hint: 0 })
    )
    pickAgentHint('end')
    expect(useOnboardingStore.getState().guide).toBeNull()
    expect(guideEvents().map((props) => props?.guide_action)).toEqual([
      'next',
      'done',
    ])
  })

  it('ends the agents hints when the setup guide starts its work, and only those', () => {
    handOff('endpoint')
    connectAgentHint()
    expect(useOnboardingStore.getState().guide).toEqual({
      path: 'endpoint',
      hint: 0,
    })

    act(() =>
      useOnboardingStore.getState().setGuide({ path: 'agents', hint: 1 })
    )
    connectAgentHint()
    expect(useOnboardingStore.getState().guide).toBeNull()
    expect(guideEvents()).toEqual([
      expect.objectContaining({
        guide_path: 'agents',
        hint: 1,
        guide_action: 'done',
      }),
    ])
  })

  describe('the Start hint over a server already running', () => {
    beforeEach(() => {
      handOff('endpoint')
      act(() =>
        useOnboardingStore.getState().setGuide({ path: 'endpoint', hint: 2 })
      )
    })

    it('says the server runs and where its address is, with Done for Skip guide', () => {
      render(<SetupGuideHint path="endpoint" hint={2} running />)

      expect(region()).toHaveTextContent(
        'onboarding-server:guide.running.title'
      )
      expect(region()).toHaveTextContent('onboarding-server:guide.running.body')
      expect(
        screen.queryByRole('button', { name: 'onboarding-server:guide.skip' })
      ).not.toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding-server:guide.done' })
      )

      expect(region()).toBeNull()
      expect(useOnboardingStore.getState().guide).toBeNull()
      // Counted as set up, as Start would have.
      expect(useServerSetup.getState()).toMatchObject({
        setupDone: true,
        endpointConfigured: true,
      })
      expect(guideEvents()).toEqual([
        expect.objectContaining({
          guide_path: 'endpoint',
          hint: 2,
          guide_action: 'done',
        }),
      ])
    })

    it('opens Connections, where the address is, ending the hints', () => {
      render(<SetupGuideHint path="endpoint" hint={2} running />)

      fireEvent.click(
        screen.getByRole('button', {
          name: 'onboarding-server:guide.viewConnection',
        })
      )

      expect(navigate).toHaveBeenCalledWith({ to: '/api/connections' })
      expect(useOnboardingStore.getState().guide).toBeNull()
    })

    it('says how to load the model once it lands, since a running server does not', () => {
      render(<SetupGuideHint path="endpoint" hint={2} running />)

      expect(
        screen.getByText('onboarding-server:guide.running.downloading')
      ).toBeInTheDocument()
      expect(
        screen.queryByText('onboarding-server:guide.downloading')
      ).not.toBeInTheDocument()

      act(() => useOnboardingStore.getState().setJobPhase('chat', 'done'))

      expect(
        screen.queryByText('onboarding-server:guide.running.downloading')
      ).not.toBeInTheDocument()
    })
  })

  it('finishes quietly when there is no guide left', () => {
    finishGuide()

    expect(useOnboardingStore.getState().guide).toBeNull()
    expect(guideEvents()).toEqual([])
  })
})
