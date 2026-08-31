import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, act } from '@testing-library/react'
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

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

const describeActive = () => {
  const el = document.activeElement as HTMLElement | null
  if (!el) return 'null'
  return `${el.tagName}[role=${el.getAttribute('role')}][aria-label=${el.getAttribute('aria-label')}]`
}

describe('repro: pickerOpen sticks across unmount', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver
  })

  beforeEach(async () => {
    selectedModel.current = undefined
    localStorage.clear()
    await useGeneralSetting.persist.rehydrate()
    useGeneralSetting.setState({
      disableReasoning: false,
      reasoningBudget: 'medium',
    })
  })

  it('B. background provider refresh drops reasoning, then it comes back', async () => {
    selectedModel.current = BUDGET_MODEL
    // `className` changes defeat the memo() bail-out, standing in for the
    // parent re-render a zustand provider update would cause.
    const { rerender } = render(<ReasoningToggle className="a" />)
    fireEvent.click(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    )
    await flush()
    expect(screen.getByRole('slider')).toBeInTheDocument()

    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    // eslint-disable-next-line no-console
    console.log('B: focus before refresh =', describeActive())

    // Background refresh #1: reasoning detection threw -> undefined.
    selectedModel.current = { id: 'qwen3', reasoning: undefined }
    rerender(<ReasoningToggle className="b" />)
    await flush()
    // eslint-disable-next-line no-console
    console.log('B: slider gone?', !screen.queryByRole('slider'))

    outside.focus()
    // Background refresh #2: detection works again.
    selectedModel.current = BUDGET_MODEL
    rerender(<ReasoningToggle className="c" />)
    await flush()
    // eslint-disable-next-line no-console
    console.log(
      'B: PANEL REOPENED BY ITSELF?',
      Boolean(screen.queryByRole('slider')),
      '| focus =',
      describeActive()
    )
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('C. clicking the bulb while the picker is open (real UI path, listeners armed)', async () => {
    selectedModel.current = BUDGET_MODEL
    render(<ReasoningToggle />)
    fireEvent.click(
      screen.getByRole('button', { name: /reasoningEffort\.ariaLabel/ })
    )
    // Let Radix arm its document-level pointerdown-outside listener.
    await flush()
    expect(screen.getByRole('slider')).toBeInTheDocument()

    const bulb = screen.getByRole('button', {
      name: 'common:reasoningToggleEnabled',
    })
    fireEvent.pointerDown(bulb, {
      pointerId: 1,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
    })
    fireEvent.mouseDown(bulb)
    fireEvent.pointerUp(bulb, { pointerId: 1, button: 0, pointerType: 'mouse' })
    fireEvent.mouseUp(bulb)
    fireEvent.click(bulb)
    await flush()
    // eslint-disable-next-line no-console
    console.log(
      'C: after bulb off -> disableReasoning =',
      useGeneralSetting.getState().disableReasoning,
      '| slider gone?',
      !screen.queryByRole('slider')
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'common:reasoningToggleDisabled' })
    )
    await flush()
    // eslint-disable-next-line no-console
    console.log(
      'C: PANEL REOPENED BY ITSELF?',
      Boolean(screen.queryByRole('slider')),
      '| focus =',
      describeActive()
    )
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })
})
