import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'

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

vi.mock('@/containers/hub/DecisionModelDetailPanel', () => ({
  DecisionModelDetailPanel: ({ model }: { model: DecisionCatalogModel }) => (
    <aside data-testid="detail">{model.id}</aside>
  ),
}))

import { useDecisionStore } from '@/stores/decision-store'
import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'
import { filterDecisionModels } from '@/lib/hub-media'
import { DecisionHub } from '../DecisionHub'

const catalog = getBaselineDecisionCatalog()
const bind = vi.fn(() => () => {})

function renderHub(
  props: Partial<React.ComponentProps<typeof DecisionHub>> = {}
) {
  const onSelectModel = vi.fn()
  const onQueryChange = vi.fn()
  render(
    <DecisionHub
      query=""
      onQueryChange={onQueryChange}
      selectedModelId="laya"
      onSelectModel={onSelectModel}
      {...props}
    />
  )
  return { onSelectModel, onQueryChange }
}

describe('DecisionHub', () => {
  beforeEach(() => {
    bind.mockClear()
    useDecisionStore.setState({
      catalog,
      installed: { 'laya-multilingual': true },
      bind,
    })
  })

  it('lists the downloaded models first, then the rest, and follows the core', () => {
    renderHub()

    const sections = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
    expect(sections).toEqual(['hub:downloaded', 'hub:available'])
    const repos = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.match(/convaiinnovations\/[\w-]+/)?.[0])
      .filter(Boolean)
    expect(repos).toEqual([
      'convaiinnovations/laya-multilingual',
      'convaiinnovations/laya',
      'convaiinnovations/laya-typed-decisions',
    ])
    expect(bind).toHaveBeenCalledOnce()
  })

  it('opens the model the URL names below its row, and reports a pick', async () => {
    const { onSelectModel } = renderHub()

    const open = screen.getByRole('button', { expanded: true })
    expect(open).toHaveTextContent('convaiinnovations/laya')
    expect(open.nextElementSibling).toBe(screen.getByTestId('detail'))
    expect(screen.getByTestId('detail')).toHaveTextContent('laya')
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(
      catalog.models.length - 1
    )

    await userEvent.click(
      screen.getByRole('button', { name: /Laya Typed Decisions/ })
    )
    expect(onSelectModel).toHaveBeenCalledWith('laya-typed-decisions')
  })

  it('closes the open model from its row', async () => {
    const { onSelectModel } = renderHub()

    const open = screen.getByRole('button', { expanded: true })
    expect(open).toHaveTextContent('convaiinnovations/laya')
    await userEvent.click(open)
    expect(onSelectModel).toHaveBeenCalledWith(null)
  })

  it('opens nothing until a model is picked', () => {
    const { onSelectModel } = renderHub({ selectedModelId: null })

    expect(screen.queryByTestId('detail')).not.toBeInTheDocument()
    expect(onSelectModel).not.toHaveBeenCalled()
  })

  it('narrows the list by the search and offers to clear an empty one', async () => {
    const { onQueryChange } = renderHub({ query: 'zzz' })

    expect(screen.getByText('hub:noModels')).toBeVisible()
    const main = screen.getByTestId('decision-hub')
    expect(within(main).queryByText('Laya')).not.toBeInTheDocument()
    const noResults = screen.getByText('hub:noModels').parentElement!
    await userEvent.click(
      within(noResults).getByRole('button', { name: 'hub:clearSearch' })
    )
    expect(onQueryChange).toHaveBeenCalledWith('')
  })
})

describe('filterDecisionModels', () => {
  it('needs every word in the name, description, repo or backbone', () => {
    const ids = (q: string) =>
      filterDecisionModels(catalog.models, q).map((m) => m.id)
    expect(ids('').slice(0, 3)).toEqual([
      'laya-multilingual',
      'laya',
      'laya-typed-decisions',
    ])
    expect(ids('')).toHaveLength(catalog.models.length)
    expect(ids('mmbert')).toEqual(['laya-multilingual', 'julia-1'])
    expect(ids('cloudflare images')).toEqual(['clef-flash', 'clef'])
    expect(ids('laya typed')).toEqual(['laya-typed-decisions'])
    expect(ids('laya nothing')).toEqual([])
  })
})
