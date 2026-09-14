import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ResetEngineSettings } from '@/containers/dialogs/ResetEngineSettings'

describe('ResetEngineSettings', () => {
  it('resets only once the user confirms', async () => {
    const onReset = vi.fn()
    const user = userEvent.setup()
    render(<ResetEngineSettings disabled={false} onReset={onReset} />)

    await user.click(
      screen.getByRole('button', {
        name: 'providers:resetEngineSettings.reset',
      })
    )
    expect(
      await screen.findByText('providers:resetEngineSettings.confirmTitle')
    ).toBeInTheDocument()
    expect(onReset).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', {
        name: 'providers:resetEngineSettings.confirm',
      })
    )
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('leaves everything alone when cancelled', async () => {
    const onReset = vi.fn()
    const user = userEvent.setup()
    render(<ResetEngineSettings disabled={false} onReset={onReset} />)

    await user.click(
      screen.getByRole('button', {
        name: 'providers:resetEngineSettings.reset',
      })
    )
    await user.click(
      await screen.findByRole('button', {
        name: 'providers:resetEngineSettings.cancel',
      })
    )
    expect(onReset).not.toHaveBeenCalled()
  })

  it('cannot be opened while nothing is off its default', () => {
    render(<ResetEngineSettings disabled onReset={vi.fn()} />)

    expect(
      screen.getByRole('button', {
        name: 'providers:resetEngineSettings.reset',
      })
    ).toBeDisabled()
  })
})
