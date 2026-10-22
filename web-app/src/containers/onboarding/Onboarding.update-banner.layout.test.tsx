import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Onboarding } from '@/containers/onboarding/Onboarding'
import { UpdateBanner } from '@/containers/UpdateBanner'
import { useOnboardingStore } from '@/stores/onboarding-store'
import { settle, withTranslations } from '@/test/layout'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))

// Welcome and Model only: the steps that depend on the machine have nothing
// to do with how the shell stacks against the banner.
vi.mock('@/containers/onboarding/useStepContext', () => ({
  useStepContext: () => ({
    winOrLinux: false,
    backendStepDone: false,
    permissionRows: 0,
    cloudProviders: 0,
    mediaCards: 0,
    localApiServer: false,
  }),
}))

// Never drawn on Welcome; mocked so its catalog stores stay unimported.
vi.mock('@/containers/onboarding/steps/ModelStep', () => ({
  ModelStep: () => null,
}))

describe('onboarding notification stacking', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().reset()
  })

  it('paints the update banner above the setup actions and below dialogs', async () => {
    await page.viewport(1280, 800)

    const app = (dialogOpen: boolean) =>
      withTranslations(
        <div className="flex h-screen w-screen overflow-hidden">
          <Onboarding />
          <UpdateBanner
            title="New Atomic Chat version"
            fromVersion="2.0.40"
            toVersion="2.0.41"
            remindLaterLabel="Remind me later"
            onRemindLater={vi.fn()}
            updateLabel="Update"
            onUpdate={vi.fn()}
            dismissLabel="Dismiss"
            onDismiss={vi.fn()}
            testId="app-update-banner"
          />
          <Dialog open={dialogOpen}>
            <DialogContent>
              <DialogTitle>Confirmation</DialogTitle>
            </DialogContent>
          </Dialog>
        </div>
      )

    const { rerender } = render(app(false))
    const shell = await screen.findByTestId('onboarding')
    const banner = await screen.findByTestId('app-update-banner')
    const skip = screen.getByRole('button', { name: /Skip setup/ })
    const primary = screen.getByRole('button', { name: /get set up/ })
    await settle(document.body)

    // The flow covers the whole window at z-30; the banner is fixed at z-40.
    expect(getComputedStyle(shell).zIndex).toBe('30')
    expect(getComputedStyle(banner).zIndex).toBe('40')

    const bannerBounds = banner.getBoundingClientRect()
    const x = bannerBounds.left + bannerBounds.width / 2
    const y = bannerBounds.top + bannerBounds.height / 2

    // Each of the flow's own actions, moved under the banner, stays inside
    // the shell's layer: present at the point, painted beneath the banner.
    for (const action of [skip, primary]) {
      Object.assign(action.style, {
        position: 'fixed',
        left: `${bannerBounds.left}px`,
        top: `${bannerBounds.top}px`,
        width: `${bannerBounds.width}px`,
        height: `${bannerBounds.height}px`,
      })

      expect(shell.contains(action)).toBe(true)
      expect(
        document
          .elementsFromPoint(x, y)
          .some((element) => element === action || action.contains(element))
      ).toBe(true)
      expect(banner.contains(document.elementFromPoint(x, y))).toBe(true)

      action.removeAttribute('style')
    }

    rerender(app(true))
    await screen.findByRole('dialog', { name: 'Confirmation' })
    const overlay = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]'
    )
    expect(overlay).not.toBeNull()
    expect(getComputedStyle(overlay!).zIndex).toBe('50')
    expect(document.elementFromPoint(x, y)).toBe(overlay)
  })
})
