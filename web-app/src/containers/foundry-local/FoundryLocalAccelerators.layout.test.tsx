import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@/i18n/setup'
import { DEFAULT_FONT_SIZE, settle, setFontSize, setTheme, withTranslations, XL_FONT_SIZE } from '@/test/layout'
import { FoundryLocalAccelerators } from './FoundryLocalAccelerators'

const PREPARE_EVENT = 'atomic-core://foundry-local:accelerators'

const events = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler)
    return () => events.handlers.delete(name)
  }),
}))
vi.mock('@/services/foundry-local/core', () => ({
  // What the core answers on an RTX laptop right after the engine was installed.
  foundryLocalAccelerators: vi.fn(async () => ({
    installed: true,
    build: 'v2.1.0/win-x64',
    version: '2.1.0',
    c_api_version: 2,
    probed_at: 1,
    error: null,
    accelerators: [
      { name: 'OpenVINOExecutionProvider', execution_provider: 'openvino', device: 'gpu/npu', prepared: false },
      { name: 'CUDAExecutionProvider', execution_provider: 'cuda', device: 'gpu', prepared: false },
      { name: 'WebGpuExecutionProvider', execution_provider: 'webgpu', device: 'gpu', prepared: true },
    ],
  })),
  prepareFoundryLocalAccelerators: vi.fn(() => new Promise(() => {})),
}))

const NAMES = ['OpenVINOExecutionProvider', 'CUDAExecutionProvider', 'WebGpuExecutionProvider']

for (const language of ['en', 'ru']) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    describe(`${language} ${font}`, () => {
      beforeEach(async () => {
        await i18n.changeLanguage(language)
        setFontSize(font)
        setTheme('dark')
      })

      afterEach(async () => {
        await i18n.changeLanguage('en')
      })

      it('keeps the accelerators apart and their status level with their name', async () => {
        render(withTranslations(<div style={{ width: 724 }}><FoundryLocalAccelerators /></div>))
        await screen.findByTestId('foundry-accelerator-CUDAExecutionProvider')
        act(() => {
          events.handlers.get(PREPARE_EVENT)?.({
            payload: { accelerator: 'CUDAExecutionProvider', stage: 'downloading', fraction: 0.24 },
          })
        })
        await act(async () => {
          await settle()
        })

        const rows = NAMES.map((name) => screen.getByTestId(`foundry-accelerator-${name}`))
        // One accelerator's device line and the next one's name must not read as one block.
        for (let i = 1; i < rows.length; i++) {
          const gap = rows[i].querySelector('h1')!.getBoundingClientRect().top - rows[i - 1].getBoundingClientRect().bottom
          expect(gap, `${NAMES[i - 1]} → ${NAMES[i]}`).toBeGreaterThanOrEqual(8)
        }
        for (const [i, row] of rows.entries()) {
          const name = row.querySelector('h1')!.getBoundingClientRect()
          const status = within(row).getByTestId('foundry-accelerator-status').getBoundingClientRect()
          expect(Math.abs(status.top - name.top), NAMES[i]).toBeLessThanOrEqual(4)
        }
      })
    })
  }
}
