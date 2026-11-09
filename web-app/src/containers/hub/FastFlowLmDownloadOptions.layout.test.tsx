import { act, render, screen } from '@testing-library/react'
import { it, vi } from 'vitest'
import i18n from '@/i18n/setup'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { FastFlowLmDownloadOptions } from './FastFlowLmDownloadOptions'
const identity = vi.hoisted(() => ({
  id: 'qwen-with-a-long-variant-name-npu2',
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (state: unknown) => unknown) =>
    selector({
      providers: [{ provider: 'fastflowlm', models: [{ id: identity.id }] }],
    }),
}))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (selector: (state: unknown) => unknown) =>
    selector({ huggingfaceToken: '' }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
  getServiceHub: () => ({}),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@/services/fastflowlm/core', () => ({
  checkFastFlowLmModel: vi.fn(async () => ({ verdict: 'ok', reason: null })),
}))
vi.mock('@/services/fastflowlm/install', () => ({
  fastFlowLmDownloadId: (id: string) => `fastflowlm-${id}`,
  fastFlowLmInstallJobs: vi.fn(async () => [
    { model_id: identity.id, state: 'publishing', running: true, plan: {} },
  ]),
  installFastFlowLm: vi.fn(),
}))
vi.mock('@/services/diffusion/transfer', () => ({ cancelTransfer: vi.fn() }))
vi.mock('@/containers/hub/DeleteModelAction', () => ({
  DeleteModelAction: () => null,
}))
vi.mock('@/utils/switchModel', () => ({ switchToModel: vi.fn() }))
const model = {
  model_name: `fastflowlm/${identity.id}`,
  fastflowlm: {
    variant_id: identity.id,
    files: [{ size: 18 * 1024 ** 3 }],
    license: 'LicenseRef-FastFlowLM-NPU-Binary-Long-License-Identifier',
    context_length: 65536,
    qualification: { status: 'upstream' },
    gated: true,
    sources: [
      {
        id: 'weights',
        repo: 'very-long-publisher/very-long-gated-selected-fastflowlm-model-variant-npu2',
        revision: 'a'.repeat(40),
      },
    ],
  } as never,
}
for (const width of [360, 724])
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    it(`keeps the active update action and metadata inside a ${width}px card at ${font}`, async () => {
      await i18n.changeLanguage('ru')
      setFontSize(font)
      setTheme(font === XL_FONT_SIZE ? 'dark' : 'light')
      useDownloadStore
        .getState()
        .updateProgress(
          `fastflowlm-${identity.id}`,
          1,
          'Qwen',
          18 * 1024 ** 3,
          18 * 1024 ** 3
        )
      const { container } = render(
        withTranslations(
          <div style={{ width }}>
            <FastFlowLmDownloadOptions model={model} />
          </div>
        )
      )
      await screen.findByRole('button', { name: /100%/ })
      await act(async () => settle(container))
      expectNoHorizontalOverflow(container.querySelector('section')!)
    })
  }
