import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@/i18n/setup'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  settle,
  setFontSize,
  setTheme,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import { foundryLocalDownloadId } from '@/lib/foundry-local/download-id'
import { seedServiceHub } from '@/test/service-hub'
import type { CatalogModel } from '@/services/models/types'
import { FoundryLocalNotReadyError, installFoundryLocalVariant } from '@/services/foundry-local/install'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { FoundryLocalDownloadOptions } from './FoundryLocalDownloadOptions'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
const verdict = vi.hoisted(() => ({ value: 'ok' }))
vi.mock('@/services/foundry-local/core', () => ({
  checkFoundryLocalVariant: vi.fn(async () => ({
    verdict: verdict.value,
    reason: verdict.value === 'ok' ? null : 'WebGpuExecutionProvider is not prepared yet.',
    accelerator: null,
  })),
}))
vi.mock('@/services/foundry-local/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/foundry-local/install')>()),
  installFoundryLocalVariant: vi.fn(),
}))
vi.mock('@/services/foundry-local/curated', () => ({
  fetchFoundryLocalList: vi.fn(async () => ({ list: {} })),
}))

const variant = (id: string, execution_provider: 'webgpu' | 'cpu', device: 'gpu' | 'cpu') => ({
  id,
  execution_provider,
  device,
  platforms: ['macos-arm64'],
  asset_id: `azureml://registries/azureml/models/${id}/versions/1`,
  version: '1',
  size_bytes: 1.4 * 1024 ** 3,
})

const MODEL: CatalogModel = {
  model_name: 'foundry-local/qwen3.5-0.8b',
  description: '',
  downloads: 0,
  is_foundry_local: true,
  foundry_local: {
    origin: 'microsoft',
    model_id: 'qwen3.5-0.8b',
    name: 'qwen3.5-0.8b',
    summary: 'apache-2.0',
    license: 'apache-2.0',
    variants: [
      variant('qwen3.5-0.8b-generic-gpu', 'webgpu', 'gpu'),
      variant('qwen3.5-0.8b-generic-cpu', 'cpu', 'cpu'),
    ],
  },
}

/** The Hub's right column: the window less the sidebar and the 420 px list. */
const panelWidth = (windowWidth: number) => windowWidth - 256 - 420

for (const language of ['en', 'ru']) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    describe(`${language} ${font}`, () => {
      beforeEach(async () => {
        await i18n.changeLanguage(language)
        setFontSize(font)
        setTheme('light')
        seedServiceHub({})
        verdict.value = 'ok'
        useDownloadStore.setState({ downloads: {}, localDownloadingModels: new Set() })
        // The WebGPU variant is on disk: its row offers New chat and delete, the CPU one Download.
        useModelProvider.setState({
          providers: [
            {
              active: true,
              provider: 'foundry-local',
              settings: [],
              models: [{ id: 'qwen3.5-0.8b-generic-gpu' }],
            } as unknown as ModelProvider,
          ],
        })
      })

      afterEach(async () => {
        await i18n.changeLanguage('en')
      })

      it('keeps the variant list as wide whichever variant is chosen', async () => {
        render(
          withTranslations(
            <div data-testid="panel-frame" style={{ width: panelWidth(1280) }}>
              <FoundryLocalDownloadOptions model={MODEL} platform="macos-arm64" />
            </div>
          )
        )
        await act(async () => {
          await settle()
        })
        const list = screen.getByRole('radiogroup')
        const downloaded = list.getBoundingClientRect().width

        fireEvent.click(screen.getAllByRole('radio')[1])
        await act(async () => {
          await settle()
        })

        expect(list.getBoundingClientRect().width).toBe(downloaded)
        expectNoHorizontalOverflow(screen.getByTestId('panel-frame'))
      })

      it('keeps the main button where it was whichever variant is chosen, the trash slot kept', async () => {
        render(
          withTranslations(
            <div data-testid="panel-frame" style={{ width: panelWidth(1280) }}>
              <FoundryLocalDownloadOptions model={MODEL} platform="macos-arm64" />
            </div>
          )
        )
        await act(async () => {
          await settle()
        })
        const mainButton = () => screen.getByTestId('foundry-local-main-action')
        const newChatRight = mainButton().getBoundingClientRect().right

        fireEvent.click(screen.getAllByRole('radio')[1])
        await act(async () => {
          await settle()
        })

        expect(mainButton().getBoundingClientRect().right).toBe(newChatRight)
      })

      it('keeps the download button, idle or counting percent, level with the first variant’s name', async () => {
        useModelProvider.setState({ providers: [] })
        render(
          withTranslations(
            <div data-testid="panel-frame" style={{ width: panelWidth(1280) }}>
              <FoundryLocalDownloadOptions model={MODEL} platform="macos-arm64" />
            </div>
          )
        )
        await act(async () => {
          await settle()
        })
        const firstName = () =>
          screen.getAllByRole('radio')[0].querySelector('.font-medium')!.getBoundingClientRect()
        const button = () =>
          screen.getByTestId('foundry-local-main-action').querySelector('button')!.getBoundingClientRect()
        const centre = (rect: DOMRect) => rect.top + rect.height / 2
        const idle = button()
        expect(Math.abs(centre(idle) - centre(firstName())), 'idle').toBeLessThanOrEqual(2)

        act(() => {
          const id = foundryLocalDownloadId('qwen3.5-0.8b-generic-gpu')
          useDownloadStore.setState({
            downloads: { [id]: { name: id, progress: 0.24 } as never },
            localDownloadingModels: new Set([id]),
          })
        })
        await act(async () => {
          await settle()
        })

        const counting = button()
        expect(Math.abs(centre(counting) - centre(firstName())), 'downloading').toBeLessThanOrEqual(2)
        expect(counting.top).toBe(idle.top)
        expect(counting.right).toBe(idle.right)
      })

      it('keeps the provider-page button inside its column', async () => {
        verdict.value = 'accelerator-not-prepared'
        useModelProvider.setState({ providers: [] })
        render(
          withTranslations(
            <div data-testid="panel-frame" style={{ width: panelWidth(1024) }}>
              <FoundryLocalDownloadOptions model={MODEL} platform="macos-arm64" />
            </div>
          )
        )
        await act(async () => {
          await settle()
        })

        expectNoHorizontalOverflow(screen.getByTestId('foundry-local-actions'))
        expectNoHorizontalOverflow(screen.getByTestId('panel-frame'))
      })

      it('fits the Foundry runtime requirement and update action at desktop widths', async () => {
        setTheme('dark')
        useModelProvider.setState({ providers: [] })
        const active = { version: 'v2.1.0', variant: 'macos-arm64' }
        const target = { ...active, version: 'v2.4.0' }
        useEngineVersionsStore.setState({
          engines: {
            'foundry-local': {
              engine: 'foundry-local', kind: 'engine-build', active_choice: 'core',
              builds: [], active, latest: target,
              update: { needed: true, target, apply: 'swap' },
              source: 'remote', source_error: null, error: null,
            },
          },
        })
        vi.mocked(installFoundryLocalVariant).mockRejectedValueOnce(
          new FoundryLocalNotReadyError({
            verdict: 'engine-update-required', reason: null, accelerator: 'WebGpuExecutionProvider',
          }, '2.4.0')
        )

        render(withTranslations(
          <div data-testid="panel-frame" style={{ width: panelWidth(1024) }}>
            <FoundryLocalDownloadOptions model={MODEL} platform="macos-arm64" />
          </div>
        ))
        const frame = screen.getByTestId('panel-frame')
        const download = await screen.findByRole('button', { name: i18n.t('hub:download') })
        fireEvent.click(download)
        await screen.findByRole('button', { name: i18n.t('hub:foundryLocal.updateEngine') })
        expect(screen.getByRole('status')).toHaveTextContent(/2\.1\.0.*2\.4\.0/)
        for (const width of [1024, 1280]) {
          frame.style.width = `${panelWidth(width)}px`
          expectNoHorizontalOverflow(frame)
          expectNoHorizontalOverflow(screen.getByTestId('foundry-local-actions'))
        }
        useEngineVersionsStore.setState({ engines: {} })
      })
    })
  }
}
