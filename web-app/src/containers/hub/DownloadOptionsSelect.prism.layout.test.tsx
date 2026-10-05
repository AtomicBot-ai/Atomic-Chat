import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'

import i18n from '@/i18n/setup'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  settle,
  setFontSize,
  setTheme,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'
import { DefaultModelSetupService } from '@/services/model-setup/default'
import type { CatalogModel } from '@/services/models/types'
import { useModelSetupStore } from '@/stores/model-setup-store'
import { DownloadOptionsSelect } from './DownloadOptionsSelect'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

const PATH =
  'https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/main/Bonsai-8B-PQ2_0.gguf'

const MODEL = {
  model_name: 'prism-ml/Bonsai-8B-gguf',
  developer: 'prism-ml',
  num_quants: 1,
  quants: [{ model_id: 'Bonsai-8B-PQ2_0', path: PATH, file_size: '12.4 GB' }],
} as unknown as CatalogModel

/** The Hub's right column: the window less the sidebar and the 420 px list. */
const panelWidth = (windowWidth: number) => windowWidth - 256 - 420

class FakeService extends DefaultModelSetupService {
  override isSupported() {
    return true
  }
}

for (const language of ['en', 'de-DE']) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    for (const windowWidth of [1024, 1280]) {
      describe(`${language} ${font} ${windowWidth}px window`, () => {
        beforeEach(async () => {
          await i18n.changeLanguage(language)
          setFontSize(font)
          setTheme('light')
          seedServiceHub({ modelSetup: new FakeService() })
          useModelSetupStore.setState({
            setups: {},
            progress: {},
            verdicts: {
              [PATH]: {
                outcome: 'engine_required',
                provider: 'atomic-prism',
                requires: ['PQ2_0'],
                evidence: 'rules',
                rules_version: 1,
                reason: 'r',
              },
            },
          })
        })

        afterEach(async () => {
          await i18n.changeLanguage('en')
        })

        it('keeps the "Requires PrismML" badge and Download inside the panel', async () => {
          render(
            withTranslations(
              <div
                data-testid="panel-frame"
                style={{ width: panelWidth(windowWidth) }}
              >
                <DownloadOptionsSelect model={MODEL} budgetBytes={0} />
              </div>
            )
          )
          await act(async () => {
            await settle()
          })

          expectNoHorizontalOverflow(screen.getByTestId('panel-frame'))
          expectOneLine(screen.getByTestId('requires-prism-badge-label'))
        })
      })
    }
  }
}
