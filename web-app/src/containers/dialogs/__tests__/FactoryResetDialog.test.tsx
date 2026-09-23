import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { FactoryResetDialog } from '@/containers/dialogs/FactoryResetDialog'

const toast = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('sonner', () => ({ toast }))

// Both tests open the dialog and start a reset the same way; share that setup
// so each test keeps only what is unique to it.
async function startReset(onReset: () => void | Promise<void>) {
  const user = userEvent.setup()
  render(
    <FactoryResetDialog onReset={onReset}>
      <button type="button">Open reset dialog</button>
    </FactoryResetDialog>
  )

  await user.click(screen.getByRole('button', { name: 'Open reset dialog' }))
  await user.click(
    await screen.findByRole('button', { name: 'settings:general.reset' })
  )

  return user
}

describe('FactoryResetDialog', () => {
  it('shows a loading state while reset is running', async () => {
    let resolveReset: (() => void) | undefined
    const onReset = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReset = resolve
        })
    )

    await startReset(onReset)

    const loadingButton = screen.getByRole('button', {
      name: 'settings:general.reset',
    })
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(loadingButton).toBeDisabled()
    expect(loadingButton).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'settings:general.cancel' })).toBeDisabled()
    expect(screen.getByText('common:loading')).toBeInTheDocument()
    expect(screen.getByText('settings:general.factoryResetTitle')).toBeInTheDocument()

    resolveReset?.()

    await waitFor(() =>
      expect(
        screen.queryByText('settings:general.factoryResetTitle')
      ).not.toBeInTheDocument()
    )
  })

  it('surfaces reset failures and keeps the dialog open', async () => {
    const error = new Error('boom')
    const onReset = vi.fn().mockRejectedValue(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await startReset(onReset)

    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'settings:general.factoryResetFailed'
      )
    )
    expect(consoleError).toHaveBeenCalledWith('Factory reset failed:', error)
    expect(
      screen.getByText('settings:general.factoryResetTitle')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'settings:general.reset' })
    ).toBeEnabled()

    consoleError.mockRestore()
  })
})
