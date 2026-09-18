import { fireEvent, render, screen, within } from '@testing-library/react'
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

  it('renders one filled branded Hugging Face Hub action', () => {
    const onClick = vi.fn()
    render(<HuggingFaceAction onClick={onClick} />)

    const action = screen.getByRole('button', {
      name: 'Download from Hugging Face',
    })
    expect(action).toHaveClass(
      'h-11',
      'border',
      'bg-secondary/70',
      'hover:bg-accent',
      'focus-visible:ring-2'
    )
    expect(
      within(action).getByRole('img', { name: 'Hugging Face' }).parentElement
    ).toHaveClass('size-7')
    fireEvent.click(action)
    expect(onClick).toHaveBeenCalledOnce()
  })
})
