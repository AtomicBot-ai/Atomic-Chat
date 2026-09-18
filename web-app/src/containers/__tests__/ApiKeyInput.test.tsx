import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { ApiKeyInput } from '../ApiKeyInput'

const field = () =>
  screen.getByPlaceholderText('common:enterApiKey') as HTMLInputElement

describe('ApiKeyInput', () => {
  beforeEach(() => {
    localStorage.clear()
    useLocalApiServer.setState({
      apiKey: '',
      exposeWithoutKeyAcknowledged: false,
    })
  })

  it('starts from the saved key', () => {
    useLocalApiServer.setState({ apiKey: 'sk-saved' })

    render(<ApiKeyInput />)

    expect(field()).toHaveValue('sk-saved')
  })

  it('shows a key that was set from outside while it is mounted', () => {
    render(<ApiKeyInput />)
    expect(field()).toHaveValue('')

    // Settings → Remote & LAN generates a key next to this field.
    act(() => {
      useLocalApiServer.getState().setApiKey('sk-atomic-generated')
    })

    expect(field()).toHaveValue('sk-atomic-generated')
  })

  it('still commits what was typed, on blur and not before', () => {
    render(<ApiKeyInput />)

    fireEvent.change(field(), { target: { value: 'sk-typed' } })
    expect(field()).toHaveValue('sk-typed')
    expect(useLocalApiServer.getState().apiKey).toBe('')

    fireEvent.blur(field())

    expect(useLocalApiServer.getState().apiKey).toBe('sk-typed')
    expect(field()).toHaveValue('sk-typed')
  })

  it('does not clobber half-typed text when something else in the store changes', () => {
    useLocalApiServer.setState({ apiKey: 'sk-saved' })
    render(<ApiKeyInput />)

    fireEvent.change(field(), { target: { value: 'sk-half-ty' } })
    act(() => {
      useLocalApiServer.getState().setRemoteAccessAutoStart(true)
      useLocalApiServer.getState().setServerPort(4000)
    })

    expect(field()).toHaveValue('sk-half-ty')
    expect(useLocalApiServer.getState().apiKey).toBe('sk-saved')
  })

  it('lets a generated key replace half-typed text', () => {
    render(<ApiKeyInput />)
    fireEvent.change(field(), { target: { value: 'sk-half-ty' } })

    act(() => {
      useLocalApiServer.getState().setApiKey('sk-atomic-generated')
    })

    expect(field()).toHaveValue('sk-atomic-generated')
  })

  it('can be cleared', () => {
    useLocalApiServer.setState({ apiKey: 'sk-saved' })
    render(<ApiKeyInput />)

    fireEvent.change(field(), { target: { value: '' } })
    fireEvent.blur(field())

    expect(useLocalApiServer.getState().apiKey).toBe('')
    expect(field()).toHaveValue('')
  })
})
