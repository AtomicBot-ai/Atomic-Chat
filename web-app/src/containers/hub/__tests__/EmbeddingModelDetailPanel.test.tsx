import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'

const navigate = vi.hoisted(() => vi.fn())
const copied = vi.hoisted(() => vi.fn())
const download = vi.hoisted(() => ({
  downloading: false,
  currentBytes: 0,
  totalBytes: 0,
}))

vi.mock('@/hooks/useEmbeddingModel', () => ({
  useEmbeddingModel: () => download,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: async (text: string) => {
    copied(text)
    return true
  },
}))

vi.mock('@/containers/hub/HubReadme', () => ({
  HubReadme: ({ url }: { url: string }) => (
    <div data-testid="readme">{url}</div>
  ),
}))

vi.mock('@/containers/EmbeddingModelCard', () => ({
  default: ({
    model,
    onOpen,
  }: {
    model: EmbeddingCatalogModel
    onOpen?: () => void
  }) => (
    <button type="button" onClick={onOpen}>
      {`actions for ${model.id}`}
    </button>
  ),
}))

import {
  embeddingDiskBytes,
  getBaselineEmbeddingCatalog,
} from '@/services/embedding-catalog-registry'
import { useModelProvider } from '@/hooks/useModelProvider'
import { EmbeddingModelDetailPanel } from '../EmbeddingModelDetailPanel'

const byId = (id: string) =>
  getBaselineEmbeddingCatalog().models.find((m) => m.id === id)!

const gemma2 = byId('embeddinggemma-2')

// Unmount first: a mounted panel would re-render outside act.
afterEach(() => {
  cleanup()
  useModelProvider.setState({ providers: [] as never })
})

describe('EmbeddingModelDetailPanel', () => {
  it('reads out the bytes in place of the size while the model downloads', () => {
    Object.assign(download, {
      downloading: true,
      currentBytes: 323 * 1024 ** 2,
      totalBytes: 825 * 1024 ** 2,
    })
    try {
      render(<EmbeddingModelDetailPanel model={gemma2} />)
      const row = screen.getByTestId('embedding-download-embeddinggemma-2')
      expect(row).toHaveTextContent(
        'settings:embedding.progress {"current":"0.32","total":"0.81"}'
      )
      expect(row).not.toHaveTextContent('settings:embedding.diskSize')
    } finally {
      Object.assign(download, {
        downloading: false,
        currentBytes: 0,
        totalBytes: 0,
      })
    }
  })

  it('asks for a pick when no model is open', () => {
    render(<EmbeddingModelDetailPanel model={null} />)

    expect(screen.getByText('hub:selectModel')).toBeVisible()
  })

  it('names the model, its quant and its size on disk with the projector, and links the repo', () => {
    render(<EmbeddingModelDetailPanel model={gemma2} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'EmbeddingGemma 2'
    )
    expect(screen.getByRole('link', { name: /hub:openOnWeb/ })).toHaveAttribute(
      'href',
      'https://huggingface.co/unsloth/embeddinggemma-2-GGUF'
    )
    const size = (embeddingDiskBytes(gemma2) / 1024 ** 3).toFixed(2)
    const row = screen.getByTestId('embedding-download-embeddinggemma-2')
    expect(row).toHaveTextContent('Q8_0')
    expect(row).toHaveTextContent(
      `settings:embedding.diskSize {"size":"${size}"}`
    )
  })

  it('shows what goes in and comes out: inputs, dimensions, context, pooling', () => {
    render(<EmbeddingModelDetailPanel model={gemma2} />)

    const modalities = screen.getByTestId(
      'embedding-modalities-embeddinggemma-2'
    )
    expect(
      within(modalities)
        .getAllByText(/hub:embeddingModality\./)
        .map((el) => el.textContent)
    ).toEqual([
      'hub:embeddingModality.text',
      'hub:embeddingModality.image',
      'hub:embeddingModality.audio',
    ])
    expect(
      screen.getByText('hub:embeddingDimensions').parentElement
    ).toHaveTextContent(
      '768 · hub:embeddingMatryoshka {"dims":"512, 256, 128"}'
    )
    expect(
      screen.getByText('hub:embeddingContextOfMax {"tokens":4096,"max":8192}')
    ).toBeVisible()
    expect(screen.getByText('mean')).toBeVisible()
    expect(screen.getByText('740M')).toBeVisible()
    expect(screen.getByText('apache-2.0')).toBeVisible()
    expect(screen.getByText('settings:embedding.multilingual')).toBeVisible()
  })

  it('shows a context the model was trained for in full as is, and a single language', () => {
    render(<EmbeddingModelDetailPanel model={byId('nomic-embed-text-v1.5')} />)

    expect(
      screen.getByText('settings:embedding.context {"tokens":2048}')
    ).toBeVisible()
    expect(screen.getByText('EN')).toBeVisible()
  })

  it('offers the prompts to copy and says the server does not add them', async () => {
    render(<EmbeddingModelDetailPanel model={gemma2} />)

    const prompts = screen.getByTestId('embedding-prompts-embeddinggemma-2')
    expect(prompts).toHaveTextContent('hub:embeddingPromptsNote')
    expect(prompts).toHaveTextContent('task: search result | query:')
    expect(prompts).toHaveTextContent('title: none | text:')
    await userEvent.click(
      within(prompts).getByRole('button', {
        name: 'hub:embeddingCopyPrompt {"name":"hub:embeddingPromptQuery"}',
      })
    )
    expect(copied.mock.calls).toEqual([['task: search result | query: ']])
  })

  it('shows only the prompt a model has, and none for a model without', () => {
    const { unmount } = render(
      <EmbeddingModelDetailPanel model={byId('qwen3-embedding-0.6b')} />
    )
    const prompts = screen.getByTestId('embedding-prompts-qwen3-embedding-0.6b')
    expect(
      within(prompts)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
    ).toEqual(['hub:embeddingCopyPrompt {"name":"hub:embeddingPromptQuery"}'])
    unmount()

    render(<EmbeddingModelDetailPanel model={byId('bge-m3')} />)
    expect(
      screen.queryByTestId('embedding-prompts-bge-m3')
    ).not.toBeInTheDocument()
  })

  it('reads the README at the revision the files come from', () => {
    render(<EmbeddingModelDetailPanel model={gemma2} />)

    expect(screen.getByTestId('readme')).toHaveTextContent(
      `https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/${gemma2.revision}/README.md`
    )
  })

  it('opens the llama.cpp page, where the model is started', async () => {
    navigate.mockClear()
    render(<EmbeddingModelDetailPanel model={gemma2} />)

    const actions = screen.getByRole('button', {
      name: 'actions for embeddinggemma-2',
    })
    expect(
      screen.getByTestId('embedding-download-embeddinggemma-2')
    ).toContainElement(actions)
    await userEvent.click(actions)

    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/providers/$providerName',
      params: { providerName: 'llamacpp-upstream' },
    })
  })

  it('says which llama.cpp build a model needs when the configured one is older', () => {
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          settings: [
            {
              key: 'version_backend',
              controller_props: { value: 'b11443/macos-arm64' },
            },
          ],
        },
      ] as never,
    })
    const { unmount } = render(<EmbeddingModelDetailPanel model={gemma2} />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'settings:embedding.requiresEngineNotice {"engine":"llama.cpp","version":"b11454"}'
    )
    unmount()

    render(<EmbeddingModelDetailPanel model={byId('bge-m3')} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
