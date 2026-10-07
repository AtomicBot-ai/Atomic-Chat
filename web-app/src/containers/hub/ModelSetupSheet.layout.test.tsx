import { act, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it } from 'vitest'

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
import type { ModelSetup, ModelSetupPlan } from '@/services/model-setup/types'
import { useModelSetupStore } from '@/stores/model-setup-store'
import { ModelSetupSheet } from './ModelSetupSheet'

const GB = 1024 ** 3

/** Worst-case copy: a long repository path and a two-digit GB total. */
const file = {
  repo: 'prism-ml/Bonsai-8B-Instruct-Long-Context-Experimental-gguf',
  file: 'Bonsai-8B-Instruct-Long-Context-Experimental-PQ2_0-00001-of-00002.gguf',
  revision: 'main',
}

const plan: ModelSetupPlan = {
  digest: 'd',
  model_id: 'prism-ml/Bonsai-8B-Instruct-Long-Context-Experimental-PQ2_0',
  provider: 'atomic-prism',
  verdict: {
    outcome: 'engine_update_required',
    provider: 'atomic-prism',
    requires: ['PQ2_0'],
    evidence: 'rules',
    rules_version: 1,
    reason: 'r',
  },
  engine: {
    provider: 'atomic-prism',
    version: 'prism-b10234-abcdef0',
    backend: 'win-cuda-12.4-x64',
    installed: false,
    download_size: 0.6 * GB,
  },
  model: { ...file, size: 14.7 * GB },
  projector: {
    ...file,
    file: 'mmproj-Bonsai-8B-Instruct-F16.gguf',
    size: 1.2 * GB,
  },
  total_download_bytes: 16.5 * GB,
  free_bytes: 912 * GB,
  blockers: [],
}

class FakeService extends DefaultModelSetupService {
  override isSupported() {
    return true
  }
  override async plan() {
    return plan
  }
}

const running: ModelSetup = {
  setup_id: 's1',
  request_id: 'r1',
  revision: 1,
  stage: 'downloading_projector',
  request: file,
  plan,
  task_ids: { engine: 'te', model: 'tm', projector: 'tp' },
  created_at: 1,
  updated_at: 1,
}

describe('model setup sheet geometry', () => {
  beforeEach(() => {
    useModelSetupStore.setState({ setups: {}, progress: {}, verdicts: {} })
    seedServiceHub({ modelSetup: new FakeService() })
  })

  for (const theme of ['light', 'dark'] as const) {
    for (const fontSize of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
      it(`fits the plan and the progress without sideways scrolling (${fontSize}, ${theme})`, async () => {
        await page.viewport(fontSize === XL_FONT_SIZE ? 1024 : 1280, 800)
        setTheme(theme)
        setFontSize(fontSize)
        render(
          withTranslations(
            <ModelSetupSheet
              open
              onOpenChange={() => {}}
              file={file}
              modelName="Bonsai 8B Instruct Long Context Experimental"
              modelId={plan.model_id}
              onReady={() => {}}
            />
          )
        )
        await screen.findByTestId('model-setup-engine')
        await settle()

        const sheet = screen.getByTestId('model-setup-sheet')
        const width = sheet.getBoundingClientRect().width
        expectNoHorizontalOverflow(sheet)
        expectOneLine(screen.getByTestId('model-setup-total'))

        // Worst-case readout: everything downloaded, a three-digit percentage.
        act(() =>
          useModelSetupStore.setState({
            setups: { s1: running },
            progress: { tp: { transferred: 1.2 * GB, total: 1.2 * GB } },
          })
        )
        await settle()
        expect(screen.getByText('100%')).toBeInTheDocument()
        expectOneLine(screen.getByTestId('model-setup-stage'))
        expect(sheet.getBoundingClientRect().width).toBeCloseTo(width, 0)
        expectNoHorizontalOverflow(sheet)
      })
    }
  }
})
