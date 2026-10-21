import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import i18n from '@/i18n/setup'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
} from '@/test/layout'

import { ConnectionDetails } from './ConnectionDetails'

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
  getServiceHub: () => ({}),
}))

// A worst-case id a client passes as `model`: a llama.cpp model's provider id.
const LONG_ID = 'unsloth/' + 'VeryLongEmbeddingModelName'.repeat(6) + '-Q8_0'

function serveEmbedding(id: string, modalities: Array<'text' | 'image'>) {
  useEmbeddingStore.setState({
    bind: () => () => {},
    config: { enabled: true, model_id: id } as never,
    status: {
      state: 'ready',
      enabled: true,
      model_id: id,
      modalities,
      error: null,
    } as never,
  })
}

beforeEach(() => {
  useDecisionStore.setState({
    bind: () => () => {},
    status: null,
    config: null,
  })
  useAppState.setState({ serverStatus: 'running', activeModels: [] } as never)
})

describe.each(['light', 'dark'] as const)(
  'the embedding model in Connection details, %s theme',
  (theme) => {
    it.each(
      [1024, 1280].flatMap((width) =>
        ['16px', '18px', '20px'].map((fontSize) => ({ width, fontSize }))
      )
    )(
      'keeps a long id on one line beside its copies at $width px / $fontSize',
      async ({ width, fontSize }) => {
        await page.viewport(width, 800)
        setTheme(theme)
        setFontSize(fontSize)
        // The `api` namespace is not loaded here: labels read as their keys.
        await i18n.changeLanguage('en')
        serveEmbedding(LONG_ID, ['text', 'image'])
        // The page column beside the 60 px rail and the 256 px sidebar.
        const { container } = render(
          <div className="flex w-full">
            <aside className="w-[316px] shrink-0">Sidebar</aside>
            <main className="min-w-0 flex-1 p-4">
              <div className="server-page">
                <ConnectionDetails />
              </div>
            </main>
          </div>
        )
        await settle(container)

        const panel = container.querySelector('.sp-panel') as HTMLElement
        expectNoHorizontalOverflow(panel)

        // The id truncates, the three copy icons stay on its line.
        const id = screen.getByTitle(LONG_ID)
        expectOneLine(id)
        for (const name of [
          'api:strip.copyEmbeddingModel',
          'api:strip.copyTextTest',
          'api:strip.copyImageTest',
        ]) {
          expectVerticallyCentered(screen.getByRole('button', { name }), id)
        }
      }
    )
  }
)
