import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledArtifact } from '@/lib/diffusion/models'
import type {
  DiffusionCatalog,
  DiffusionCatalogFamily,
} from '@/services/diffusion-catalog-registry'

const store = vi.hoisted(() => ({
  catalog: null as DiffusionCatalog | null,
  installedArtifacts: [] as InstalledArtifact[],
}))

vi.mock('@/stores/image-generation-store', () => ({
  useImageGenerationStore: (selector: (s: typeof store) => unknown) =>
    selector(store),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))

// Import has tests of its own and needs the service hub.
vi.mock('@/containers/hub/ImportLocalFile', () => ({
  ImportLocalFile: () => null,
}))

// The panel has tests of its own; here it only has to say which family the
// Hub handed it.
vi.mock('@/containers/hub/MediaFamilyDetailPanel', () => ({
  MediaFamilyDetailPanel: ({
    family,
  }: {
    family: DiffusionCatalogFamily
  }) => <aside data-testid="media-panel">{family.id}</aside>,
}))

import { MediaHub, type MediaHubProps } from '../MediaHub'

const familyFixture = (
  id: string,
  extra: Partial<DiffusionCatalogFamily> = {}
): DiffusionCatalogFamily =>
  ({
    id,
    name: `${id} name`,
    modality: 'image',
    engines: ['sdcpp'],
    transformer: {
      repo: `owner/${id}`,
      quants: [{ id: 'q4', label: 'Q4', filename: `${id}.gguf`, bytes: 1 }],
    },
    text_encoders: [],
    ...extra,
  }) as DiffusionCatalogFamily

const installed = (family: string): InstalledArtifact => ({
  id: `${family}:q4`,
  family,
  quantId: 'q4',
  bytes: 1,
  complete: true,
  missing: [],
})

const renderHub = (props: Partial<MediaHubProps> = {}) => {
  const onSelectFamily = vi.fn()
  const onQueryChange = vi.fn()
  const view = render(
    <MediaHub
      modality="image"
      query=""
      onQueryChange={onQueryChange}
      selectedFamilyId="z-image"
      onSelectFamily={onSelectFamily}
      {...props}
    />
  )
  return { ...view, onSelectFamily, onQueryChange }
}

// A family without a bundled icon draws its initial, so the row's text is
// read from its name alone. The search box's cross is not a row.
const rowNames = () =>
  screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-label') !== 'hub:clearSearch')
    .map((button) => within(button).getByText(/ name$/).textContent)

describe('MediaHub', () => {
  beforeEach(() => {
    store.catalog = {
      schema_version: 1,
      families: [
        familyFixture('z-image'),
        familyFixture('flux.1-schnell'),
        familyFixture('qwen-image'),
        familyFixture('wan', { modality: 'video' }),
      ],
    } as DiffusionCatalog
    store.installedArtifacts = [installed('qwen-image')]
  })

  it('lists the installed families first, then the rest, of its modality only', () => {
    renderHub()

    const installedSection = screen
      .getByRole('heading', { name: 'images:model.installed' })
      .closest('section')!
    const availableSection = screen
      .getByRole('heading', { name: 'images:model.available' })
      .closest('section')!
    const namesIn = (section: HTMLElement) =>
      within(section)
        .getAllByRole('button')
        .map((row) => within(row).getByText(/ name$/).textContent)
    expect(namesIn(installedSection)).toEqual(['qwen-image name'])
    expect(namesIn(availableSection)).toEqual([
      'z-image name',
      'flux.1-schnell name',
    ])
    expect(screen.queryByText('wan name')).not.toBeInTheDocument()
  })

  it('opens the family the URL names below its row', () => {
    renderHub()

    const open = screen.getByRole('button', { expanded: true })
    expect(within(open).getByText(/ name$/)).toHaveTextContent('z-image name')
    expect(open.nextElementSibling).toBe(screen.getByTestId('media-panel'))
    expect(screen.getByTestId('media-panel')).toHaveTextContent('z-image')
  })

  it('narrows the list to the search, open family included', () => {
    renderHub({ query: 'flux' })

    expect(rowNames()).toEqual(['flux.1-schnell name'])
    expect(screen.queryByTestId('media-panel')).not.toBeInTheDocument()
  })

  it('reports each keystroke of the search box', async () => {
    const { onQueryChange } = renderHub()

    await userEvent.type(
      screen.getByRole('textbox', { name: 'hub:searchImagePlaceholder' }),
      'qw'
    )

    expect(onQueryChange.mock.calls).toEqual([['q'], ['w']])
  })

  it('opens a family when its row is clicked, and closes the open one', async () => {
    const { onSelectFamily } = renderHub()

    await userEvent.click(
      screen.getByRole('button', { name: /flux.1-schnell/ })
    )
    expect(onSelectFamily.mock.calls.at(-1)).toEqual(['flux.1-schnell'])

    await userEvent.click(screen.getByRole('button', { name: /z-image/ }))
    expect(onSelectFamily.mock.calls.at(-1)).toEqual([null])
  })

  it('opens nothing when the URL names no family of this modality', () => {
    const { onSelectFamily } = renderHub({ selectedFamilyId: 'wan' })

    expect(onSelectFamily.mock.calls).toEqual([])
    expect(screen.queryByTestId('media-panel')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { expanded: true })
    ).not.toBeInTheDocument()
  })

  it('searches video models in the Video category', () => {
    renderHub({ modality: 'video', selectedFamilyId: 'wan' })

    expect(rowNames()).toEqual(['wan name'])
    expect(
      screen.getByRole('textbox', { name: 'hub:searchVideoPlaceholder' })
    ).toBeInTheDocument()
  })

  it('says the catalog is loading before it arrives', () => {
    store.catalog = null
    const { onSelectFamily } = renderHub({ selectedFamilyId: null })

    expect(screen.getByText('images:model.loadingCatalog')).toBeInTheDocument()
    expect(onSelectFamily.mock.calls).toEqual([])
  })

  it('says nothing matched a search that hides every family, and offers to clear it', async () => {
    const { onQueryChange } = renderHub({ query: 'nothing like this' })

    expect(screen.getByText('hub:noModels')).toBeInTheDocument()
    const clears = screen.getAllByRole('button', { name: 'hub:clearSearch' })
    // The cross in the search box and the button under the message.
    expect(clears).toHaveLength(2)
    await userEvent.click(clears[1])
    expect(onQueryChange.mock.calls).toEqual([['']])
  })

  it('clears the search box from its cross, which shows only while there is text', async () => {
    const empty = renderHub()
    expect(
      screen.queryByRole('button', { name: 'hub:clearSearch' })
    ).not.toBeInTheDocument()
    empty.unmount()

    const { onQueryChange } = renderHub({ query: 'flux' })
    await userEvent.click(screen.getByRole('button', { name: 'hub:clearSearch' }))

    expect(onQueryChange.mock.calls).toEqual([['']])
  })
})
