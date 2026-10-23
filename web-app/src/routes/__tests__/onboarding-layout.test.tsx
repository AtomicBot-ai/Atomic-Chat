import { act, render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { isOnboardingOnScreen } from '@/lib/onboarding'

/**
 * `AppLayout` draws the setup screen full-window and every other page beside
 * the navigation. The setup screen re-opens the run whenever it mounts after
 * a handoff, so leaving it must not mount it again in the other branch.
 */
function renderShell(mounts: () => void) {
  function Setup() {
    useEffect(() => {
      mounts()
    }, [])
    return <h1>setup</h1>
  }
  function Layout() {
    const onOnboarding = useRouterState({
      select: (state) => isOnboardingOnScreen(state.matches),
    })
    return onOnboarding ? (
      <Outlet />
    ) : (
      <main>
        <Outlet />
      </main>
    )
  }
  const root = createRootRoute({ component: Layout })
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/',
        component: () => <h1>home</h1>,
      }),
      createRoute({
        getParentRoute: () => root,
        path: '/onboarding',
        component: Setup,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
  })
  render(<RouterProvider router={router} />)
  return router
}

describe('the setup screen in the app shell', () => {
  it('is mounted once while the handoff navigates away from it', async () => {
    const mounts = vi.fn()
    const router = renderShell(mounts)
    expect(await screen.findByRole('heading', { name: 'setup' })).toBeVisible()

    await act(() => router.navigate({ to: '/', replace: true }))

    expect(await screen.findByRole('heading', { name: 'home' })).toBeVisible()
    expect(screen.getByRole('main')).toContainElement(
      screen.getByRole('heading', { name: 'home' })
    )
    expect(mounts).toHaveBeenCalledTimes(1)
  })
})
