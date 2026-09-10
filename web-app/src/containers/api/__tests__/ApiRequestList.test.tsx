import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiLogEntry, ApiRequestEntry } from '@/types/apiServerLog'
import { filterEntries } from '@/hooks/useApiServerLog'

import { ApiRequestList } from '../ApiRequestList'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}))

// Same approach as `routes/hub/__tests__/index.test.tsx`: jsdom has no layout,
// so the virtualizer would render nothing.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 64,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 64,
        size: 64,
      })),
    measureElement: () => {},
  }),
}))

function request(
  id: string,
  overrides: Partial<ApiRequestEntry> = {}
): ApiRequestEntry {
  return {
    kind: 'request',
    id,
    seq: 0,
    startedAt: 1_700_000_000_000,
    status: 'completed',
    method: 'POST',
    endpoint: 'chat/completions',
    model: 'gemma-4',
    stream: true,
    durationMs: 3500,
    ...overrides,
  }
}

const ENTRIES: ApiLogEntry[] = [
  request('a', { promptPreview: 'What is Unsloth?' }),
  request('b', { status: 'error', errorKind: 'upstream_status', model: 'llama' }),
  request('c', { status: 'in_flight' }),
]

function renderList(overrides: Partial<Parameters<typeof ApiRequestList>[0]> = {}) {
  const props = {
    entries: ENTRIES,
    filter: 'all' as const,
    query: '',
    selectedId: null,
    onSelect: vi.fn(),
    onFilterChange: vi.fn(),
    onQueryChange: vi.fn(),
    onClearFilters: vi.fn(),
    emptyLog: false,
    ...overrides,
  }
  return { ...render(<ApiRequestList {...props} />), props }
}

describe('ApiRequestList', () => {
  it('renders one row per entry with its endpoint and model', () => {
    renderList()
    expect(screen.getAllByText('/chat/completions')).toHaveLength(3)
    expect(screen.getByText('llama')).toBeInTheDocument()
    expect(screen.getByText('What is Unsloth?')).toBeInTheDocument()
  })

  it('reports the selected row and forwards clicks', () => {
    const { props } = renderList({ selectedId: 'b' })
    fireEvent.click(screen.getByText('llama'))
    expect(props.onSelect).toHaveBeenCalledWith('b')
  })

  it('forwards search input', () => {
    const { props } = renderList()
    fireEvent.change(screen.getByPlaceholderText('api:log.searchPlaceholder'), {
      target: { value: 'unsloth' },
    })
    expect(props.onQueryChange).toHaveBeenCalledWith('unsloth')
  })

  it('shows the empty-log message when there is no traffic at all', () => {
    renderList({ entries: [], emptyLog: true })
    expect(screen.getByText('api:log.empty')).toBeInTheDocument()
    expect(screen.queryByText('api:log.clearFilters')).not.toBeInTheDocument()
  })

  it('offers to clear filters when a filter hid everything', () => {
    const { props } = renderList({ entries: [], emptyLog: false })
    expect(screen.getByText('api:log.noMatches')).toBeInTheDocument()
    fireEvent.click(screen.getByText('api:log.clearFilters'))
    expect(props.onClearFilters).toHaveBeenCalled()
  })

  // The filtering itself is pure; assert it here so the list and the store
  // agree on what each filter means.
  it('is fed by filterEntries, which narrows by status and query', () => {
    expect(filterEntries(ENTRIES, 'errors', '').map((e) => e.id)).toEqual(['b'])
    expect(filterEntries(ENTRIES, 'all', 'unsloth').map((e) => e.id)).toEqual(['a'])
  })
})
