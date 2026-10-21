import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  HuggingFaceAction,
  ModelPickerEmptyState,
} from '../ModelPickerDownloads'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'common:modelPicker.downloadFromHuggingFace')
        return 'Download from Hugging Face'
      if (key === 'common:modelPicker.noRunnableModels')
        return 'No runnable models yet.'
      return vars ? `${key}:${JSON.stringify(vars)}` : key
    },
  }),
}))

describe('ModelPickerDownloads', () => {
  it('renders concise empty and runnable-search no-results copy', () => {
    const view = render(<ModelPickerEmptyState query="" />)
    expect(screen.getByTestId('model-picker-empty')).toHaveTextContent(
      'No runnable models yet.'
    )

    view.rerender(<ModelPickerEmptyState query="mistral" />)
    expect(screen.getByTestId('model-picker-empty')).toHaveTextContent(
      'common:noModelsFoundFor:{"searchValue":"mistral"}'
    )
  })

  it('renders the Hub action as a regular small secondary button', () => {
    const onClick = vi.fn()
    render(<HuggingFaceAction onClick={onClick} />)

    const action = screen.getByRole('button', {
      name: 'Download from Hugging Face',
    })
    expect(action).toHaveAttribute('data-slot', 'button')
    expect(action).toHaveAttribute('data-variant', 'secondary')
    expect(action).toHaveAttribute('data-size', 'sm')
    expect(action).toHaveClass('h-[var(--control-height,2.25rem)]', 'w-full')
    const logo = action.querySelector('img')
    expect(logo).toHaveAttribute('aria-hidden')
    expect(logo).toHaveClass('size-4')
    fireEvent.click(action)
    expect(onClick).toHaveBeenCalledOnce()
  })
})
