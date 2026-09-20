import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Sidebar, SidebarProvider, SidebarRail } from './sidebar'

describe('SidebarRail', () => {
  it('toggles the sidebar on click and keeps the hover glow enabled', async () => {
    const user = userEvent.setup()

    render(
      <SidebarProvider defaultOpen>
        <Sidebar>
          <div>Sidebar content</div>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>
    )

    const rail = screen.getByRole('button', {
      name: 'Toggle or resize sidebar',
    })

    expect(rail).not.toHaveAttribute('data-no-hover-glow')
    expect(rail.closest('[data-state="expanded"]')).toBeTruthy()

    await user.click(rail)

    expect(rail.closest('[data-state="collapsed"]')).toBeTruthy()
  })

  it('toggles the sidebar from the keyboard', async () => {
    const user = userEvent.setup()

    render(
      <SidebarProvider defaultOpen>
        <Sidebar>
          <div>Sidebar content</div>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>
    )

    await user.tab()
    expect(screen.getByRole('button', { name: 'Toggle or resize sidebar' })).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(
      screen
        .getByRole('button', { name: 'Toggle or resize sidebar' })
        .closest('[data-state="collapsed"]')
    ).toBeTruthy()
  })
})
