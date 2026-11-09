import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
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
import { FastFlowLmPreparation } from './FastFlowLmPreparation'
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@/services/fastflowlm/core', () => ({
  probeFastFlowLm: vi.fn(async () => ({
    status: 'blocked',
    blockers: ['driver-missing'],
    driver_setup: {
      title: 'Install the AMD NPU driver and restart your computer',
      steps: [
        'Check the driver and permissions for the runtime account before continuing.',
      ],
      commands: [
        'sudo example-display-only-command --runtime-account very-long-runtime-account-name --device /dev/accel/accel0',
      ],
      links: [
        {
          label: 'Download the AMD NPU driver for Windows 11',
          url: 'https://www.amd.com/en/support',
        },
      ],
    },
  })),
  fastFlowLmOperations: vi.fn(async () => []),
  beginFastFlowLmPreparation: vi.fn(),
  consentFastFlowLmPreparation: vi.fn(),
  resumeFastFlowLmPreparation: vi.fn(),
  cancelFastFlowLmPreparation: vi.fn(),
}))
for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE])
  for (const theme of ['light', 'dark'] as const)
    for (const width of [768, 996]) {
      it(`fits NPU guidance at ${width}px with ${font} ${theme}`, async () => {
        await i18n.changeLanguage('ru')
        setFontSize(font)
        setTheme(theme)
        const { container } = render(
          withTranslations(
            <div style={{ width }}>
              <FastFlowLmPreparation />
            </div>
          )
        )
        await screen.findByText(
          'Install the AMD NPU driver and restart your computer'
        )
        await act(async () => settle(container))
        expect(container.querySelector('section')).toBeTruthy()
        expectNoHorizontalOverflow(container.querySelector('section')!)
      })
    }
