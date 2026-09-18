import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from '@vitest/browser/context'

import DropdownModelProvider from './DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelLoad } from '@/hooks/useModelLoad'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'
import { route } from '@/constants/routes'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

const testState = vi.hoisted(() => ({
  effort: '',
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => testState.navigate,
}))
vi.mock('@/containers/ModelSupportStatus', () => ({
  ModelSupportStatus: () => null,
}))
vi.mock('@/containers/ActiveModelIndicator', () => ({
  ActiveModelIndicator: () => null,
}))
vi.mock('@/containers/ReasoningEffortPanel', () => ({ default: () => null }))
vi.mock('@/hooks/useReasoningEffort', () => ({
  useReasoningEffort: () => ({ levelLabel: testState.effort }),
}))

const localModel = {
  id: 'community/Qwen3-235B-A22B-Instruct-2507-Long-Context.gguf',
  capabilities: ['completion'],
} as Model

const pickerProviders = [
  {
    provider: 'llamacpp-upstream',
    active: true,
    models: [
      localModel,
      { id: 'mmproj-Qwen3-f16.gguf' },
      { id: 'Qwen3-sidecar.gguf' },
      { id: 'llamacpp-backend-metal' },
      { id: 'Whisper-voice-model', capabilities: ['transcription'] },
      { id: 'Flux-image-model', capabilities: ['image-generation'] },
      { id: 'Missing-chat.gguf', missing: true },
    ],
    settings: [],
  },
  {
    provider: 'openai',
    active: true,
    api_key: 'sk-layout',
    models: [{ id: 'gpt-4.1-cloud', capabilities: ['completion'] }],
    settings: [{ key: 'api-key' }],
  },
  {
    provider: 'chatgpt',
    active: true,
    api_key: '',
    models: [{ id: 'gpt-5.1-codex', capabilities: [] }],
    settings: [],
  },
  {
    provider: 'anthropic',
    active: true,
    api_key: '',
    models: [{ id: 'disconnected-claude', capabilities: ['completion'] }],
    settings: [{ key: 'api-key' }],
  },
  {
    provider: 'stable-diffusion',
    active: true,
    persist: true,
    models: [{ id: 'flux-schnell' }],
    settings: [],
  },
  {
    provider: 'inactive-provider',
    active: false,
    api_key: 'configured',
    models: [{ id: 'inactive-chat', capabilities: ['completion'] }],
    settings: [],
  },
] as unknown as ModelProvider[]

const setProviders = (
  providers: ModelProvider[],
  selectedProvider = '',
  selectedModel?: Model
) => {
  useModelProvider.setState({ providers, selectedProvider, selectedModel })
}

const trigger = () =>
  document.querySelector(
    '[data-test-id="model-picker-trigger"]'
  ) as HTMLButtonElement

async function openModelList() {
  fireEvent.click(trigger())
  const changeModel = screen.queryByRole('button', { name: 'Change model' })
  if (changeModel) fireEvent.click(changeModel)
  return screen.findByPlaceholderText('Search models...')
}

beforeEach(() => {
  testState.effort = ''
  testState.navigate.mockReset()
  useModelLoad.setState({ modelSelectionDeferred: true })
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    pausedDownloads: new Set(),
  })
  setProviders([])
  seedServiceHub({
    models: {
      getActiveModels: async () => [],
      checkMmprojExists: async () => false,
      checkMmprojExistsAndUpdateOffloadMMprojSetting: async () => undefined,
    } as unknown as ModelsService,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('model selector geometry', () => {
  for (const width of [1024, 1280, 390]) {
    for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
      for (const theme of ['light', 'dark'] as const) {
        it(`${width}px, ${font}, ${theme}: combines runnable sources in one bounded picker`, async () => {
          await page.viewport(width, 800)
          setFontSize(font)
          setTheme(theme)
          setProviders(pickerProviders)

          render(
            withTranslations(
              <div style={{ position: 'fixed', bottom: 24, right: 24 }}>
                <DropdownModelProvider />
              </div>
            )
          )

          const emptyLabel = trigger().querySelector<HTMLElement>('.truncate')!
          expect(emptyLabel.textContent).toBe('Select Model')
          expectOneLine(emptyLabel)
          expect(emptyLabel.scrollWidth).toBeLessThanOrEqual(
            emptyLabel.clientWidth + 1
          )

          const search = await openModelList()
          const panel = search.closest(
            '[data-slot="popover-content"]'
          ) as HTMLElement
          await settle(panel)
          const bounds = panel.getBoundingClientRect()
          expect(bounds.width).toBeCloseTo(Math.min(352, width - 32), 0)
          expect(bounds.left).toBeGreaterThanOrEqual(8)
          expect(bounds.right).toBeLessThanOrEqual(width)
          expectNoHorizontalOverflow(panel)

          for (const provider of [
            'llama.cpp',
            'OpenAI',
            'ChatGPT subscription (Codex)',
          ]) {
            expect(within(panel).getByTitle(provider)).toBeVisible()
          }
          for (const id of [
            localModel.id,
            'gpt-4.1-cloud',
            'gpt-5.1-codex',
          ]) {
            expect(within(panel).getAllByTitle(id).length).toBeGreaterThan(0)
          }
          for (const id of [
            'mmproj-Qwen3-f16.gguf',
            'Qwen3-sidecar.gguf',
            'llamacpp-backend-metal',
            'Whisper-voice-model',
            'Flux-image-model',
            'Missing-chat.gguf',
            'disconnected-claude',
            'flux-schnell',
            'inactive-chat',
          ]) {
            expect(within(panel).queryAllByTitle(id)).toHaveLength(0)
          }

          fireEvent.change(search, { target: { value: 'codex' } })
          expect(
            within(panel).getAllByTitle('gpt-5.1-codex').length
          ).toBeGreaterThan(0)
          expect(within(panel).queryAllByTitle(localModel.id)).toHaveLength(0)
          fireEvent.change(search, { target: { value: 'OpenAI' } })
          expect(
            within(panel).getAllByTitle('gpt-4.1-cloud').length
          ).toBeGreaterThan(0)
          fireEvent.change(search, { target: { value: 'qwen' } })
          expect(
            within(panel).getAllByTitle(localModel.id).length
          ).toBeGreaterThan(0)
          expect(
            within(panel).queryAllByTitle('gpt-5.1-codex')
          ).toHaveLength(0)

          const footer = within(panel).getByRole('button', {
            name: 'Download from Hugging Face',
          })
          expectOneLine(
            within(footer).getByText('Download from Hugging Face')
          )
          expect(footer.getBoundingClientRect().height).toBeCloseTo(44, 0)
          const footerStyle = getComputedStyle(footer)
          expect(footerStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
          expect(parseFloat(footerStyle.borderTopWidth)).toBeGreaterThan(0)
          const logo = within(footer).getByRole('img', {
            name: 'Hugging Face',
          }).parentElement as HTMLElement
          expect(logo.getBoundingClientRect().width).toBeCloseTo(28, 0)
          expect(logo.getBoundingClientRect().height).toBeCloseTo(28, 0)
        })
      }
    }
  }

  it('gives the Hub action a real hover state and leaves the picker to navigate', async () => {
    await page.viewport(1024, 800)
    setFontSize(DEFAULT_FONT_SIZE)
    setTheme('light')
    setProviders(pickerProviders)
    render(
      withTranslations(
        <div className="fixed bottom-6 right-6">
          <DropdownModelProvider />
        </div>
      )
    )

    const search = await openModelList()
    const panel = search.closest('[data-slot="popover-content"]') as HTMLElement
    const footer = within(panel).getByRole('button', {
      name: 'Download from Hugging Face',
    })
    await userEvent.unhover(footer)
    const beforeHover = getComputedStyle(footer).backgroundColor
    await userEvent.hover(footer)
    await waitFor(() =>
      expect(getComputedStyle(footer).backgroundColor).not.toBe(beforeHover)
    )

    await act(async () => {
      fireEvent.click(footer)
    })
    expect(testState.navigate).toHaveBeenCalledWith({ to: route.hub.index })
    expect(
      screen.queryByPlaceholderText('Search models on Hugging Face...')
    ).toBeNull()
  })

  it('widens the selected-model reading area without moving mic or Send', async () => {
    await page.viewport(1024, 800)
    setFontSize(XL_FONT_SIZE)
    setTheme('dark')
    testState.effort = 'Medium'
    setProviders(pickerProviders, 'llamacpp-upstream', localModel)

    render(
      withTranslations(
        <div className="fixed bottom-6 right-6 flex items-center gap-2">
          <DropdownModelProvider />
          <button type="button" aria-label="Microphone" className="size-8" />
          <button type="button" aria-label="Send" className="size-8" />
        </div>
      )
    )

    const shell = screen.getByTestId('model-picker-pill-shell')
    const name = trigger().querySelector<HTMLElement>('.truncate')!
    const effort = within(trigger()).getByText('Medium')
    const mic = screen.getByRole('button', { name: 'Microphone' })
    const send = screen.getByRole('button', { name: 'Send' })
    const fixedPositions = [mic, send].map(
      (element) => element.getBoundingClientRect().left
    )

    expect(shell.getBoundingClientRect().width).toBeCloseTo(168, 0)
    // The 168 px shell is 40 px wider than the old 128 px shell, all of
    // which goes to the model-name slot because effort and controls stay put.
    expect(name.clientWidth).toBeGreaterThanOrEqual(55)
    expectOneLine(name)
    expectOneLine(effort)

    fireEvent.click(trigger())
    await screen.findByRole('dialog')
    expect([mic, send].map((el) => el.getBoundingClientRect().left)).toEqual(
      fixedPositions
    )
    fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
    await screen.findByPlaceholderText('Search models...')
    expect([mic, send].map((el) => el.getBoundingClientRect().left)).toEqual(
      fixedPositions
    )
  })
})
