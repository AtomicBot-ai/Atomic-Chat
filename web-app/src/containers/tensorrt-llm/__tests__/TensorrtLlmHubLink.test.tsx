import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { TensorrtLlmHubLink } from '../TensorrtLlmHubLink'
import { route } from '@/constants/routes'

describe('TensorrtLlmHubLink', () => {
  it('opens the Model Hub on the TensorRT-LLM format', () => {
    // spec "Переход к выбору модели".
    render(<TensorrtLlmHubLink />)

    expect(screen.getByText('providers:tensorrt.hub.body')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.hub.action' }))

    expect(navigate).toHaveBeenCalledWith({
      to: route.hub.index,
      search: { engine: 'tensorrt-llm' },
    })
  })
})
