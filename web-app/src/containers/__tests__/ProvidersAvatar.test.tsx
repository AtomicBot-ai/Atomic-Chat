import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import ProvidersAvatar from '@/containers/ProvidersAvatar'

const avatar = (provider: string) =>
  render(
    <ProvidersAvatar provider={{ provider } as unknown as ProviderObject} />
  )

describe('ProvidersAvatar', () => {
  it('tints PrismML’s mark to the text color and scales it to the marks beside it', () => {
    avatar('atomic-prism')

    const mark = screen.getByRole('img', { name: 'atomic-prism - Logo' })
    expect(mark.tagName).toBe('SPAN')
    expect(mark.style.maskImage).toBe(
      'url(/images/model-provider/prism-ml.webp)'
    )
    expect(mark.style.maskSize).toBe('78%')
  })

  it('keeps every other monochrome mark at its full size', () => {
    avatar('minimax')

    const mark = screen.getByRole('img', { name: 'minimax - Logo' })
    expect(mark.style.maskSize).toBe('contain')
  })
})
