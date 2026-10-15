import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@/i18n/setup'
import { DEFAULT_FONT_SIZE, settle, setFontSize, setTheme, withTranslations, XL_FONT_SIZE } from '@/test/layout'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { FoundryLocalEnginePanel } from './FoundryLocalEnginePanel'

vi.mock('@/services/engine-builds/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/engine-builds/install')>()),
  // The core has not answered yet: no progress, no result.
  installEngineBuildWithProgress: vi.fn(() => new Promise(() => {})),
}))
vi.mock('@/containers/engines/InstalledEngineBuilds', () => ({ InstalledEngineBuilds: () => null }))

for (const language of ['en', 'ru']) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    describe(`${language} ${font}`, () => {
      beforeEach(async () => {
        await i18n.changeLanguage(language)
        setFontSize(font)
        setTheme('light')
        useEngineVersionsStore.setState({
          engines: {
            'foundry-local': {
              engine: 'foundry-local',
              kind: 'engine-build',
              active_choice: 'core',
              builds: [],
              active: null,
              latest: { version: 'v2.1.0', variant: 'macos-arm64' },
              update: { needed: false, target: null, apply: 'swap' },
              source: 'remote',
              source_error: null,
              error: null,
            },
          },
          refresh: async () => {},
        })
      })

      afterEach(async () => {
        await i18n.changeLanguage('en')
      })

      it('keeps the install button’s size while it waits for the core', async () => {
        render(withTranslations(<div style={{ width: 724 }}><FoundryLocalEnginePanel /></div>))
        await act(async () => {
          await settle()
        })
        const button = screen.getByRole('button', { name: /v2\.1\.0/ })
        const before = button.getBoundingClientRect()

        fireEvent.click(button)
        // Not `settle()`: it waits for animations to finish, and the loader spins until the core answers.
        await act(async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        })

        expect(button.getAttribute('aria-busy')).toBe('true')
        const after = button.getBoundingClientRect()
        expect(after.width).toBe(before.width)
        expect(after.height).toBe(before.height)
      })
    })
  }
}
