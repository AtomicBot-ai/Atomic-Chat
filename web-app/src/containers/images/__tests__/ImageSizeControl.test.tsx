import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { ImageSizeControl, type ImageSizeValue } from '../ImageSizeControl'

const SD = { minDim: 256, maxDim: 2048, dimMultiple: 16 }

describe('ImageSizeControl', () => {
  it('gives a preset one size menu and no width or height to contradict it', () => {
    const value: ImageSizeValue = { width: 1024, height: 1024, aspect: 'square', portrait: false }
    render(<ImageSizeControl value={value} constraints={SD} onChange={vi.fn()} />)
    expect(screen.getByTestId('image-size-preset')).toHaveTextContent('1024 × 1024')
    expect(screen.queryByLabelText('images:size.width')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('images:size.height')).not.toBeInTheDocument()
  })

  it('names the ratio the way the image is turned', () => {
    const value: ImageSizeValue = { width: 768, height: 1024, aspect: 'photo', portrait: true }
    render(<ImageSizeControl value={value} constraints={SD} onChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'images:size.aspectRatio' })).toHaveTextContent(
      '(3:4)'
    )
  })

  it('frees width and height under Custom, snapping what is typed', () => {
    const onChange = vi.fn()
    const value: ImageSizeValue = { width: 1024, height: 768, aspect: 'custom', portrait: false }
    render(<ImageSizeControl value={value} constraints={SD} onChange={onChange} />)
    expect(screen.queryByTestId('image-size-preset')).not.toBeInTheDocument()

    const height = screen.getByLabelText('images:size.height')
    fireEvent.change(height, { target: { value: '1100' } })
    fireEvent.blur(height)
    expect(onChange).toHaveBeenCalledWith({
      width: 1024,
      height: 1104,
      aspect: 'custom',
      portrait: true,
    })
  })
})
