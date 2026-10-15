import { render, screen } from '@testing-library/react'
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
import type {
  CompatibilityVerdict,
  PrismCatalog,
  PrismFamiliesResponse,
} from '@/services/model-setup/types'
import { ModelSetupSheet } from './ModelSetupSheet'

const GB = 1024 ** 3

/** Worst-case copy: a long repository path and a two-digit GB total. */
const file = {
  repo: 'prism-ml/Bonsai-8B-Instruct-Long-Context-Experimental-gguf',
  file: 'Bonsai-8B-Instruct-Long-Context-Experimental-PQ2_0-00001-of-00002.gguf',
  revision: 'main',
}
const modelId = 'prism-ml/Bonsai-8B-Instruct-Long-Context-Experimental-PQ2_0'

const verdict: CompatibilityVerdict = {
  outcome: 'engine_update_required',
  provider: 'atomic-prism',
  requires: ['PQ2_0'],
  evidence: 'rules',
  rules_version: 1,
  min_prism_build: 10234,
  reason: 'r',
}

const families: PrismFamiliesResponse = {
  rules_version: 1,
  families: [
    {
      id: 'bonsai-8b-instruct',
      title: 'Bonsai 8B Instruct',
      repo: file.repo,
      revision: 'b072e1d',
      files: [
        {
          file: file.file,
          size: 14.7 * GB,
          sha256: 'a'.repeat(64),
          treatment: 'prism_required',
          default: true,
        },
      ],
      projectors: [
        {
          file: 'mmproj-Bonsai-8B-Instruct-F16.gguf',
          size: 1.2 * GB,
          sha256: 'c'.repeat(64),
          default: true,
        },
      ],
    },
  ],
}

const catalog: PrismCatalog = {
  installed: [],
  available: [{ version: 'prism-b10234-abcdef0', backend: 'win-cuda-12.4-x64' }],
  recommended: 'prism-b10234-abcdef0/win-cuda-12.4-x64',
  releases: [
    {
      tag: 'prism-b10234-abcdef0',
      variants: [{ id: 'win-cuda-12.4-x64', size: 0.6 * GB }],
    },
  ],
}

class FakeService extends DefaultModelSetupService {
  freeBytes = 912 * GB
  override isSupported() {
    return true
  }
  override async checkCompatibility() {
    return verdict
  }
  override async families() {
    return families
  }
  override async prismCatalog() {
    return catalog
  }
  override async diskAvailable() {
    return this.freeBytes
  }
}

describe('model setup sheet geometry', () => {
  let service: FakeService
  beforeEach(() => {
    service = new FakeService()
    seedServiceHub({ modelSetup: service })
  })

  const renderSheet = () =>
    render(
      withTranslations(
        <ModelSetupSheet
          open
          onOpenChange={() => {}}
          file={file}
          modelName="Bonsai 8B Instruct Long Context Experimental"
          modelId={modelId}
          onStart={() => {}}
        />
      )
    )

  for (const theme of ['light', 'dark'] as const) {
    for (const fontSize of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
      it(`fits the plan without sideways scrolling (${fontSize}, ${theme})`, async () => {
        await page.viewport(fontSize === XL_FONT_SIZE ? 1024 : 1280, 800)
        setTheme(theme)
        setFontSize(fontSize)
        renderSheet()
        await screen.findByTestId('model-setup-engine')
        await settle()

        const sheet = screen.getByTestId('model-setup-sheet')
        expectNoHorizontalOverflow(sheet)
        expectOneLine(screen.getByTestId('model-setup-total'))
      })

      it(`fits a disk-space blocker without sideways scrolling (${fontSize}, ${theme})`, async () => {
        await page.viewport(fontSize === XL_FONT_SIZE ? 1024 : 1280, 800)
        setTheme(theme)
        setFontSize(fontSize)
        service.freeBytes = 3.4 * GB
        renderSheet()
        await screen.findByTestId('model-setup-engine')
        await settle()

        const sheet = screen.getByTestId('model-setup-sheet')
        expectNoHorizontalOverflow(sheet)
        expect(screen.getByTestId('model-setup-start')).toBeDisabled()
      })
    }
  }
})
