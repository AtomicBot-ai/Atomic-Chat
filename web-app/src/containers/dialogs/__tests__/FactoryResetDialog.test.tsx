import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { FactoryResetDialog } from '@/containers/dialogs/FactoryResetDialog'

describe('FactoryResetDialog', () => {
  it('shows a loading state while reset is running', async () => {
    const user = userEvent.setup()
    let resolveReset: (() => void) | undefined
    const onReset = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReset = resolve
        })
    )

    render(
      <FactoryResetDialog onReset={onReset}>
        <button type="button">Open reset dialog</button>
      </FactoryResetDialog>
    )

    await user.click(screen.getByRole('button', { name: 'Open reset dialog' }))
    await user.click(
      await screen.findByRole('button', { name: 'settings:general.reset' })
    )

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
})
