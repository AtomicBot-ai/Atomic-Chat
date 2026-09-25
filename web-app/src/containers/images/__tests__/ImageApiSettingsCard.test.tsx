import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDiffusion } from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}))

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { ImageApiSettingsCard } from '../ImageApiSettingsCard'

// The endpoint on the Images and Video pages is served by the Local API Server. An image-only user
// saw the URL, got a refused connection, and had no way from here to bring the server up.
describe('the embedded image API card', () => {
  const startServer = vi.fn()
  const models = {
    getActiveModels: vi.fn(async () => [] as string[]),
    startModel: vi.fn(),
    stopModel: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    startServer.mockResolvedValue(1337)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).core = { api: { startServer } }
    useLocalApiServer.getState().setServerPort(1337)
    useAppState.getState().setServerStatus('stopped')
    seedServiceHub({
      app: { getServerStatus: vi.fn(async () => false) } as never,
      models: models as never,
      diffusion: makeFakeDiffusion(),
    })
  })

  it.each([
    ['images', '/v1/images/generations'],
    ['videos', '/v1/videos'],
  ] as const)('starts a stopped server in place for %s, loading no chat model for it', async (resource, path) => {
    render(<ImageApiSettingsCard variant="embedded" resource={resource} />)
    expect(screen.getByTestId('image-api-endpoint')).toHaveTextContent(path)
    expect(screen.getByTestId('image-api-server-stopped')).toHaveTextContent(
      'settings:media.apiServerStopped'
    )

    await userEvent.click(screen.getByTestId('image-api-start-server'))

    await waitFor(() =>
      expect(screen.queryByTestId('image-api-server-stopped')).toBeNull()
    )
    expect(useAppState.getState().serverStatus).toBe('running')
    expect(startServer).toHaveBeenCalledTimes(1)
    expect(models.getActiveModels).not.toHaveBeenCalled()
    expect(models.startModel).not.toHaveBeenCalled()
  })

  it('offers nothing to start while the server runs', () => {
    useAppState.getState().setServerStatus('running')
    render(<ImageApiSettingsCard variant="embedded" resource="videos" />)
    expect(screen.getByTestId('image-api-endpoint')).toHaveTextContent('/v1/videos')
    expect(screen.queryByTestId('image-api-server-stopped')).toBeNull()
    expect(screen.queryByTestId('image-api-start-server')).toBeNull()
  })

  it('holds the button while the server is coming up', () => {
    useAppState.getState().setServerStatus('pending')
    render(<ImageApiSettingsCard variant="embedded" />)
    const button = screen.getByTestId('image-api-start-server')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('settings:localApiServer.startingServer')
  })

  it('leaves the settings card to link to the API screen', () => {
    render(<ImageApiSettingsCard />)
    expect(screen.getByText('settings:media.apiServerStopped')).toBeInTheDocument()
    expect(screen.queryByTestId('image-api-start-server')).toBeNull()
  })
})
