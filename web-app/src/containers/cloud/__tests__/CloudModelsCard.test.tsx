import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CloudModelsCard } from '../CloudModelsCard'
import { useProviderModelFetchStore } from '@/stores/provider-model-fetch-store'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/provider-registry-store', () => ({
  isKnownProvider: () => false,
}))

vi.mock('@/containers/dialogs/AddModel', () => ({
  DialogAddModel: () => <span />,
}))
vi.mock('@/containers/dialogs/DeleteModel', () => ({
  DialogDeleteModel: () => <span />,
}))
vi.mock('@/containers/dialogs/EditModel', () => ({
  DialogEditModel: () => <span />,
}))
vi.mock('@/containers/FavoriteModelAction', () => ({
  FavoriteModelAction: () => <span />,
}))

const provider = {
  provider: 'b-ai',
  base_url: 'https://api.b.ai/v1',
  models: [],
  settings: [],
} as unknown as ProviderObject

/**
 * ATO — #293: an empty model list had exactly one appearance, whether the
 * catalogue was genuinely empty, the key was rejected, or — as in the report —
 * the app never managed to ask. The reason was reported once, in a toast, on
 * whichever page triggered the refresh.
 */
describe('CloudModelsCard empty state', () => {
  beforeEach(() => {
    useProviderModelFetchStore.setState({ errors: {} })
  })

  it('shows the generic hint when nothing has failed', () => {
    render(
      <CloudModelsCard
        provider={provider}
        refreshing={false}
        onRefresh={() => {}}
      />
    )

    expect(screen.getByText('providers:noModelFoundDesc')).toBeTruthy()
  })

  it('shows why the listing failed instead of "no models"', () => {
    useProviderModelFetchStore.setState({
      errors: {
        'b-ai': 'Authentication failed: an API key is required or invalid.',
      },
    })

    render(
      <CloudModelsCard
        provider={provider}
        refreshing={false}
        onRefresh={() => {}}
      />
    )

    expect(
      screen.getByText(
        'Authentication failed: an API key is required or invalid.'
      )
    ).toBeTruthy()
    expect(screen.queryByText('providers:noModelFoundDesc')).toBeNull()
  })

  it('keeps the error scoped to its own provider', () => {
    useProviderModelFetchStore.setState({
      errors: { 'some-other-provider': 'Cannot connect' },
    })

    render(
      <CloudModelsCard
        provider={provider}
        refreshing={false}
        onRefresh={() => {}}
      />
    )

    expect(screen.getByText('providers:noModelFoundDesc')).toBeTruthy()
  })
})
