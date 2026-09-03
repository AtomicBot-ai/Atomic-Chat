import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

const root = () =>
  screen.getByRole('slider').closest('span[class*="touch-none"]') as HTMLElement
const thumbWrapper = () => root().lastElementChild as HTMLElement

describe('probe: dragging stuck after escape mid-drag', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver
    Element.prototype.setPointerCapture = function () {}
    Element.prototype.releasePointerCapture = function () {}
    Element.prototype.hasPointerCapture = function (this: Element) {
      return this.getAttribute('role') === 'slider'
    }
  })

  beforeEach(async () => {
    selectedModel.current = BUDGET_MODEL
    localStorage.clear()
    await useGeneralSetting.persist.rehydrate()
    useGeneralSetting.setState({ disableReasoning: false, reasoningBudget: 'medium' })
  })

  it('escape mid-drag', async () => {
    render(<ReasoningToggle />)
    const trigger = screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    fireEvent.click(trigger)

    console.log('BASELINE glide=', root().className.includes('[&>span:last-child]:transition-[left]'), 'left=', thumbWrapper().style.left)

    const slider = screen.getByRole('slider')
    fireEvent.pointerDown(slider, { pointerId: 1, button: 0 })
    fireEvent.pointerMove(slider, { pointerId: 1 })
    console.log('DRAGGING glide=', root().className.includes('[&>span:last-child]:transition-[left]'))

    fireEvent.keyDown(slider, { key: 'Escape' })
    console.log('AFTER ESC sliders=', screen.queryAllByRole('slider').length)

    act(() => { useGeneralSetting.setState({ reasoningBudget: 'max' }) })

    fireEvent.click(trigger)
    const s2 = screen.getByRole('slider')
    console.log('REOPEN glide=', root().className.includes('[&>span:last-child]:transition-[left]'), 'aria-valuenow=', s2.getAttribute('aria-valuenow'), 'left=', thumbWrapper().style.left)

    fireEvent.keyDown(s2, { key: 'ArrowLeft' })
    console.log('AFTER ARROW glide=', root().className.includes('[&>span:last-child]:transition-[left]'), 'left=', thumbWrapper().style.left)
    expect(true).toBe(true)
  })

  it('does a later click on the slider recover it', async () => {
    render(<ReasoningToggle />)
    const trigger = screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    fireEvent.click(trigger)
    const slider = screen.getByRole('slider')
    fireEvent.pointerDown(slider, { pointerId: 1, button: 0 })
    fireEvent.pointerMove(slider, { pointerId: 1 })
    fireEvent.keyDown(slider, { key: 'Escape' })
    act(() => { useGeneralSetting.setState({ reasoningBudget: 'max' }) })
    fireEvent.click(trigger)
    const s2 = screen.getByRole('slider')
    console.log('B4CLICK glide=', root().className.includes('[&>span:last-child]:transition-[left]'), 'left=', thumbWrapper().style.left)
    fireEvent.pointerDown(s2, { pointerId: 2, button: 0 })
    fireEvent.pointerUp(s2, { pointerId: 2, button: 0 })
    console.log('AFTERCLICK glide=', root().className.includes('[&>span:last-child]:transition-[left]'), 'left=', thumbWrapper().style.left, 'budget=', useGeneralSetting.getState().reasoningBudget)
    expect(true).toBe(true)
  })
})
