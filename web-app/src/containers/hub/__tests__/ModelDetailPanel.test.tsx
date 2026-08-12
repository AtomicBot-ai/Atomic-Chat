import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  fetchModelStats: vi.fn(async () => ({})),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (
    selector: (state: {
      hardwareData: { total_memory: number; gpus: unknown[] }
    }) => unknown
  ) => selector({ hardwareData: { total_memory: 32 * 1024, gpus: [] } }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: string }) => unknown
  ) => selector({ huggingfaceToken: '' }),
}))

vi.mock('@/containers/ModelDownloadAction', () => ({
  ModelDownloadAction: () => <button type="button">download</button>,
}))

vi.mock('@/containers/MlxModelDownloadAction', () => ({
  MlxModelDownloadAction: () => <button type="button">download mlx</button>,
}))

vi.mock('@/lib/model-card', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/model-card')>('@/lib/model-card')
  return { ...actual, fetchModelStats: mocks.fetchModelStats }
})

import { ModelDetailPanel } from '../ModelDetailPanel'

const model = (overrides: Partial<CatalogModel> = {}): CatalogModel =>
  ({
    model_name: 'Qwen/Qwen3.5-4B-GGUF',
    developer: 'Qwen',
    downloads: 4200,
    likes: 77,
    num_quants: 1,
    quants: [
      { model_id: 'Qwen3.5-4B-Q4_K_M', path: 'q4.gguf', file_size: '2.50 GB' },
    ],
    ...overrides,
  }) as CatalogModel

const README_WITH_ART = `# Qwen3.5 4B

![hero banner](https://example.com/banner.png)

<img src="https://img.shields.io/badge/license-apache-blue" alt="license" />

<picture>
  <source srcset="https://example.com/dark.png" media="(prefers-color-scheme: dark)" />
  <img src="https://example.com/light.png" alt="logo" />
</picture>

A compact all-rounder. See the [model card](https://huggingface.co/Qwen) for details.
`

describe('ModelDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchModelStats.mockResolvedValue({})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prompts for a selection when no model is active', () => {
    render(<ModelDetailPanel model={null} />)

    expect(screen.getByText('hub:selectModel')).toBeInTheDocument()
  })

  it('renders the header, stats and details grid', () => {
    render(
      <ModelDetailPanel
        model={model({ last_modified: '2026-08-01T00:00:00Z' })}
      />
    )

    expect(
      screen.getByRole('heading', { name: 'Qwen3.5-4B-GGUF' })
    ).toBeInTheDocument()
    expect(screen.getByText('Qwen/Qwen3.5-4B-GGUF')).toBeInTheDocument()
    expect(screen.getByText(/^4.200$/)).toBeInTheDocument()
    expect(screen.getByText('77')).toBeInTheDocument()
    expect(screen.getByText('4B')).toBeInTheDocument()
    expect(screen.getByText('gguf')).toBeInTheDocument()
    expect(screen.getByText('hub:context')).toBeInTheDocument()
    const details = screen.getByRole('heading', { name: 'hub:details' })
      .parentElement!
    const downloadOptions = screen.getByRole('heading', {
      name: 'hub:downloadOptions',
    }).parentElement!
    expect(
      downloadOptions.compareDocumentPosition(details) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(within(details).getByText(/^4.200$/)).toBeInTheDocument()
    expect(within(details).getByText('77')).toBeInTheDocument()
    expect(within(details).getByText('hub:updatedAgo')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /hub:openOnWeb/ })).toHaveAttribute(
      'href',
      'https://huggingface.co/Qwen/Qwen3.5-4B-GGUF'
    )
  })

  it('uses a staff pick title without its badge or summary', () => {
    render(
      <ModelDetailPanel
        model={model()}
        pick={{
          model_name: 'Qwen/Qwen3.5-4B-GGUF',
          title: 'Qwen3.5 4B',
          summary: 'Compact all-rounder.',
        }}
      />
    )

    expect(
      screen.getByRole('heading', { name: 'Qwen3.5 4B' })
    ).toBeInTheDocument()
    expect(screen.queryByText('hub:staffPickBadge')).not.toBeInTheDocument()
    expect(screen.queryByText('Compact all-rounder.')).not.toBeInTheDocument()
  })

  it('says so when the repo ships no README', () => {
    render(<ModelDetailPanel model={model()} />)

    expect(screen.getByText('hub:readmeUnavailable')).toBeInTheDocument()
  })

  it('renders the README without a single image, keeping links clickable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => README_WITH_ART }))
    )

    const { container } = render(
      <ModelDetailPanel
        model={model({ readme: 'https://example.com/README.md' })}
      />
    )

    await waitFor(() =>
      expect(screen.getByText(/A compact all-rounder/)).toBeInTheDocument()
    )

    // Scoped to the rendered markdown: the panel header legitimately draws the
    // publisher logo as an <img>.
    const markdown = container.querySelector('.markdown')
    expect(markdown).not.toBeNull()
    expect(markdown!.querySelectorAll('img')).toHaveLength(0)
    expect(markdown!.querySelectorAll('picture')).toHaveLength(0)
    expect(markdown!.querySelectorAll('source')).toHaveLength(0)

    const link = screen.getByRole('link', { name: 'model card' })
    expect(link).toHaveAttribute('href', 'https://huggingface.co/Qwen')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('drops the YAML frontmatter ahead of the README body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        text: async () =>
          '---\r\nlicense: apache-2.0\r\nbase_model: Qwen/Qwen3.5-4B\r\n---\r\n\r\nReal content here.\r\n',
      }))
    )

    render(
      <ModelDetailPanel
        model={model({ readme: 'https://example.com/README.md' })}
      />
    )

    await waitFor(() =>
      expect(screen.getByText(/Real content here/)).toBeInTheDocument()
    )
    expect(screen.queryByText(/license: apache-2.0/)).not.toBeInTheDocument()
  })
})
