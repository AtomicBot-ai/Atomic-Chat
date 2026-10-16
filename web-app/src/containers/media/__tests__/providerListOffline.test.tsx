/**
 * The default build ships the media registry as a bundled snapshot and has no
 * remote copy to check, so the Media settings must not offer a "Check for new
 * providers" control that could only fail. The override build is covered by
 * `providerSettings.test.tsx`.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderList } from '../ProviderList'
import { MEDIA_REGISTRY_URL } from '@/services/media-registry'
import { useMediaProviderStore } from '@/stores/media-provider-store'

vi.mock('@/i18n/react-i18next-compat', async () => {
  const setup = await vi.importActual<{
    default: { t: (k: string, o?: Record<string, unknown>) => string }
  }>('@/i18n/setup')
  return {
    useTranslation: () => ({ t: setup.default.t, i18n: setup.default }),
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => null,
}))

describe('ProviderList without a media registry override', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('has no remote registry to check', () => {
    expect(MEDIA_REGISTRY_URL).toBeNull()
  })

  it('does not offer to check for new providers, and fetches nothing', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    useMediaProviderStore.setState({ providers: [] })

    render(<ProviderList />)

    expect(screen.getByText('Configured providers')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Check for new providers' })
    ).not.toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
