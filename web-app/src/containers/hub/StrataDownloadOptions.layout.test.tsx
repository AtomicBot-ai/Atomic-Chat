import { act, render, screen } from '@testing-library/react'
import { it, vi } from 'vitest'
import type { StrataModelDescriptor } from '@atomic-chat/core/contracts'
import fixture from '@/services/strata/__tests__/fixtures/catalog.json'
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
import { StrataDownloadOptions } from './StrataDownloadOptions'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
  getServiceHub: () => ({}),
}))
vi.mock('@/utils/switchModel', () => ({ switchToModel: vi.fn() }))
vi.mock('@/containers/hub/DeleteModelAction', () => ({
  DeleteModelAction: () => null,
}))
vi.mock('@/services/strata/engine', () => ({ installStrataEngine: vi.fn() }))
vi.mock('@/services/engine-builds/core', () => ({
  engineBuildCatalog: vi.fn(async () => ({ active: { tag: 'local' } })),
}))
vi.mock('@/services/strata/core', () => ({
  syncStrataSettings: vi.fn(),
  checkStrataModel: vi.fn(async () => ({
    verdict: 'ok',
    reason: null,
    estimates: {
      required_disk_bytes: 91 * 1024 ** 3,
      unified_memory_bytes: 47 * 1024 ** 3,
    },
    warnings: [
      'Режим SSD позволяет запускать более крупные модели и может снизить скорость генерации.',
    ],
  })),
}))
vi.mock('@/services/strata/install', () => ({
  cancelStrata: vi.fn(),
  installStrata: vi.fn(),
  listStrataJobs: vi.fn(async () => []),
  resumeStrata: vi.fn(),
  strataTaskId: (id: string) => `strata-model-${id}`,
}))

const descriptor = {
  ...Object.values(fixture.models)[0].definition,
  license:
    'LicenseRef-LicenseWithPotentiallyUnbrokenAndVeryLongIdentifierForModelWeights',
} as StrataModelDescriptor

for (const width of [768, 1024]) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    it(`keeps the Strata card within ${width}px at ${font}`, async () => {
      await i18n.changeLanguage('ru')
      setFontSize(font)
      setTheme(font === XL_FONT_SIZE ? 'dark' : 'light')
      const { container } = render(
        withTranslations(
          <div style={{ width }}>
            <StrataDownloadOptions descriptor={descriptor} />
          </div>
        )
      )
      await screen.findByText(/Режим SSD/)
      await act(async () => settle(container))
      expectNoHorizontalOverflow(container.querySelector('section')!)
    })
  }
}
