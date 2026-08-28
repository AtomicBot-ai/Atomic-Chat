import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReasoningControls } from '@janhq/core'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import ReasoningToggle from '../ReasoningToggle'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options?.level ? `${key}:${options.level}` : key,
  }),
}))

const selectedModel = vi.hoisted(() => ({
  current: undefined as { id: string; reasoning?: ReasoningControls } | undefined,
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (state: unknown) => unknown) =>
    selector({ selectedModel: selectedModel.current }),
}))

const BUDGET_MODEL = { id: 'qwen3', reasoning: { supportsThinking: true } }

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('ReasoningToggle', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver
  })


  beforeEach(async () => {
    selectedModel.current = undefined
    // The store is persisted, so settle any pending rehydrate before seeding
    // state: one resolving mid-test would otherwise restore what an earlier
    // test wrote and undo a click.
    localStorage.clear()
    await useGeneralSetting.persist.rehydrate()
    useGeneralSetting.setState({
      disableReasoning: false,
      reasoningBudget: 'medium',
    })
  })

  it('offers no effort picker for a model without a thinking phase', () => {
    selectedModel.current = { id: 'llama3', reasoning: { supportsThinking: false } }

    render(<ReasoningToggle />)

    expect(
      screen.getByRole('button', { name: 'common:reasoningToggleEnabled' })
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('keeps the chosen level on offer while no model is selected', () => {
    // Cold launch: nothing to clamp against yet, and an effort pill that
    // disappears until a model is picked reads as a lost setting.
    selectedModel.current = undefined

    render(<ReasoningToggle />)

    expect(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    ).toHaveTextContent('common:reasoningEffort.medium')
  })

  it('hides the effort picker while reasoning is off', () => {
    selectedModel.current = BUDGET_MODEL
    useGeneralSetting.setState({ disableReasoning: true })

    render(<ReasoningToggle />)

    expect(
      screen.getByRole('button', { name: 'common:reasoningToggleDisabled' })
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('shows the effort picker beside the bulb for a thinking model', () => {
    selectedModel.current = BUDGET_MODEL

    render(<ReasoningToggle />)

    expect(
      screen.getByRole('button', { name: 'common:reasoningToggleEnabled' })
    ).toBeInTheDocument()
    // The trigger carries the level alone; "thinking" only lives in its aria-label.
    expect(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    ).toHaveTextContent('common:reasoningEffort.medium')
  })

  it('leaves switching reasoning on and off to the bulb alone', () => {
    selectedModel.current = BUDGET_MODEL

    render(<ReasoningToggle />)
    const bulb = screen.getByRole('button', {
      name: 'common:reasoningToggleEnabled',
    })
    expect(bulb).toHaveAttribute('aria-pressed', 'true')
    // fireEvent, not userEvent: the bulb sits inside a Radix tooltip trigger,
    // and the hover choreography userEvent performs first swallows the click
    // in jsdom often enough to make the test flaky.
    fireEvent.click(bulb)

    expect(useGeneralSetting.getState().disableReasoning).toBe(true)
    // The level survives the round trip, so re-enabling restores it.
    expect(useGeneralSetting.getState().reasoningBudget).toBe('medium')
  })

  it('clamps the shown level to what the model offers', () => {
    selectedModel.current = {
      id: 'hunyuan3',
      reasoning: {
        supportsThinking: true,
        effortKwarg: 'reasoning_effort',
        effortValues: ['low', 'high'],
      },
    }

    render(<ReasoningToggle />)

    expect(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    ).toHaveTextContent('common:reasoningEffort.low')
  })

  it('presents the effort scale as a slider under an Effort heading', () => {
    selectedModel.current = BUDGET_MODEL

    render(<ReasoningToggle />)
    fireEvent.click(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    )

    // The heading repeats the current level and the scale is framed by the
    // faster/smarter endpoints.
    expect(
      screen.getByText('common:reasoningEffort.title').parentElement
    ).toHaveTextContent('common:reasoningEffort.medium')
    expect(
      screen.getByText('common:reasoningEffort.faster')
    ).toBeInTheDocument()
    expect(
      screen.getByText('common:reasoningEffort.smarter')
    ).toBeInTheDocument()
    // One stop per level, and the thumb announces the level, not its index.
    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '4')
    expect(slider).toHaveAttribute('aria-valuenow', '1')
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      'common:reasoningEffort.medium'
    )
  })

  it('accents the top tier in the heading', () => {
    selectedModel.current = BUDGET_MODEL
    useGeneralSetting.setState({ reasoningBudget: 'max' })

    render(<ReasoningToggle />)
    fireEvent.click(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    )

    const heading = screen.getByText('common:reasoningEffort.title')
      .parentElement as HTMLElement
    expect(within(heading).getByText('common:reasoningEffort.max')).toHaveClass(
      'text-blue-500'
    )
  })

  it('changes the level from the slider', () => {
    selectedModel.current = BUDGET_MODEL

    render(<ReasoningToggle />)
    fireEvent.click(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    )
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyUp(slider, { key: 'End' })

    expect(useGeneralSetting.getState().reasoningBudget).toBe('max')
    expect(useGeneralSetting.getState().disableReasoning).toBe(false)
  })
})
