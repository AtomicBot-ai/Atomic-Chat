import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
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
  current: undefined as
    | { id: string; reasoning?: ReasoningControls }
    | undefined,
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (state: unknown) => unknown) =>
    selector({ selectedModel: selectedModel.current }),
}))

const BUDGET_MODEL = { id: 'qwen3', reasoning: { supportsThinking: true } }

/** The class that carries the glide; Radix positions the thumb wrapper, not the thumb. */
const GLIDE_CLASS = '[&>span:last-child]:transition-[left]'

/** The heading, which stacks every level name in one cell and fades between them. */
const heading = () =>
  screen.getByText('common:reasoningEffort.title').parentElement as HTMLElement

/** The one level name the heading is actually showing; the rest sit faded behind it. */
const shownLevel = () => {
  const shown = Array.from(heading().querySelectorAll('span')).filter((span) =>
    span.className.includes('opacity-100')
  )
  expect(shown).toHaveLength(1)
  return shown[0]
}

/** The top-tier wash that sits over the neutral fill, found from the thumb up. */
const accentWash = () =>
  screen
    .getByRole('slider')
    .closest('span[class*="touch-none"]')!
    .querySelector('[class*="bg-linear-to-r"]') as HTMLElement

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('ReasoningToggle', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver
    // jsdom ships none of the pointer-capture API, and both Radix and the
    // free-running check gate on it, so a drag is untestable without these.
    Element.prototype.setPointerCapture = function setPointerCapture() {}
    Element.prototype.releasePointerCapture =
      function releasePointerCapture() {}
    Element.prototype.hasPointerCapture = function hasPointerCapture() {
      return true
    }
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
    selectedModel.current = {
      id: 'llama3',
      reasoning: { supportsThinking: false },
    }

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
    // faster/smarter endpoints. Every level name is in the DOM for the
    // crossfade, so the assertion has to be about the one on show.
    expect(shownLevel()).toHaveTextContent('common:reasoningEffort.medium')
    expect(
      within(heading()).getByText('common:reasoningEffort.low')
    ).toHaveAttribute('aria-hidden', 'true')
    expect(
      screen.getByText('common:reasoningEffort.faster')
    ).toBeInTheDocument()
    expect(
      screen.getByText('common:reasoningEffort.smarter')
    ).toBeInTheDocument()
    // The scale spans every level, and the thumb announces the level, not its index.
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

    expect(shownLevel()).toHaveTextContent('common:reasoningEffort.max')
    expect(shownLevel()).toHaveClass('text-blue-500')
  })

  it('moves a whole level per arrow key, not one sub-step', () => {
    // The slider runs on a fine internal scale so a drag can track the pointer,
    // which would otherwise turn an arrow press into an invisible nudge.
    selectedModel.current = BUDGET_MODEL

    render(<ReasoningToggle />)
    fireEvent.click(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    )
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })

    expect(useGeneralSetting.getState().reasoningBudget).toBe('high')
    expect(slider).toHaveAttribute('aria-valuenow', '2')
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      'common:reasoningEffort.high'
    )

    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(useGeneralSetting.getState().reasoningBudget).toBe('medium')

    fireEvent.keyDown(slider, { key: 'Home' })
    expect(useGeneralSetting.getState().reasoningBudget).toBe('low')
    // Already at the bottom: the scale clamps instead of wrapping round.
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(useGeneralSetting.getState().reasoningBudget).toBe('low')
    expect(shownLevel()).toHaveTextContent('common:reasoningEffort.low')
  })

  it('keeps the blue wash for the top tier alone', () => {
    selectedModel.current = BUDGET_MODEL
    // Seeded here as well as in beforeEach: the assertion below is about *not*
    // being the top tier, so it must not inherit a level from anywhere else.
    useGeneralSetting.setState({ reasoningBudget: 'medium' })

    render(<ReasoningToggle />)
    fireEvent.click(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    )
    expect(accentWash()).toHaveClass('opacity-0')
    expect(shownLevel()).not.toHaveClass('text-blue-500')

    fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' })

    expect(useGeneralSetting.getState().reasoningBudget).toBe('max')
    expect(accentWash()).toHaveClass('opacity-100')
  })

  it('runs free under the pointer and settles on release', async () => {
    selectedModel.current = BUDGET_MODEL
    useGeneralSetting.setState({ reasoningBudget: 'medium' })

    render(<ReasoningToggle />)
    fireEvent.click(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    )
    const root = screen
      .getByRole('slider')
      .closest('span[class*="touch-none"]') as HTMLElement
    // The glide is armed a frame after the panel opens, not on mount: Radix
    // corrects the thumb by half its width once it has measured it, and that
    // correction must not play as a slide.
    expect(root).not.toHaveClass(GLIDE_CLASS)
    await waitFor(() => expect(root).toHaveClass(GLIDE_CLASS))

    fireEvent.pointerDown(root, { pointerId: 1 })
    fireEvent.pointerMove(root, { pointerId: 1 })

    // Under the pointer the thumb is placed, not animated — jsdom has no
    // layout, so Radix reads a zero-width track and lands on the first level.
    expect(root).not.toHaveClass(GLIDE_CLASS)
    expect(useGeneralSetting.getState().reasoningBudget).toBe('low')

    fireEvent.pointerUp(root, { pointerId: 1 })

    expect(root).toHaveClass(GLIDE_CLASS)
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '0')
  })

  it('does not strand a drag that the closing panel cuts short', async () => {
    selectedModel.current = BUDGET_MODEL
    useGeneralSetting.setState({ reasoningBudget: 'medium' })

    render(<ReasoningToggle />)
    const trigger = screen.getByRole('button', {
      name: /reasoningEffort\.ariaLabel/,
    })
    fireEvent.click(trigger)
    const root = screen
      .getByRole('slider')
      .closest('span[class*="touch-none"]') as HTMLElement
    await waitFor(() => expect(root).toHaveClass(GLIDE_CLASS))

    fireEvent.pointerDown(root, { pointerId: 1 })
    fireEvent.pointerMove(root, { pointerId: 1 })
    expect(root).not.toHaveClass(GLIDE_CLASS)

    // Escape tears the slider out of the DOM with the pointer still down: no
    // pointer-up ever arrives, and the browser aims `lostpointercapture` at the
    // document, where no React handler can see it. Nothing on the slider can
    // clear the flag, so closing the panel has to.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull())

    fireEvent.click(trigger)
    const reopened = screen
      .getByRole('slider')
      .closest('span[class*="touch-none"]') as HTMLElement
    await waitFor(() => expect(reopened).toHaveClass(GLIDE_CLASS))
  })

  it('relabels the trigger only once the picker closes', () => {
    selectedModel.current = BUDGET_MODEL

    render(<ReasoningToggle />)
    const trigger = screen.getByRole('button', {
      name: /reasoningEffort\.ariaLabel/,
    })
    fireEvent.click(trigger)
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyUp(slider, { key: 'End' })

    // The trigger sizes the whole toolbar row, so it holds still while the
    // panel is open; the panel heading is what tracks the drag.
    expect(trigger).toHaveTextContent('common:reasoningEffort.medium')
    expect(shownLevel()).toHaveTextContent('common:reasoningEffort.max')

    fireEvent.click(trigger)

    expect(trigger).toHaveTextContent('common:reasoningEffort.max')
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
