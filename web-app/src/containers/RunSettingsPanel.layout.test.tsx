import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunSettingsPanel } from '@/containers/RunSettingsPanel'
import { useAssistant } from '@/hooks/useAssistant'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'
import {
  expectNoHorizontalOverflow,
  setFontSize,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

function seedLocalModel() {
  const model = {
    id: 'test-model',
    name: 'Test model',
    settings: {
      ctx_len: {
        key: 'ctx_len',
        title: 'Context Size',
        description: 'Size of the prompt context.',
        controller_type: 'input',
        controller_props: {
          type: 'number',
          value: 8192,
          min: 0,
          max: 65536,
          step: 1024,
        },
      },
    },
  } as unknown as Model
  useModelProvider.setState({
    providers: [{ provider: 'llamacpp', models: [model] } as ModelProvider],
    selectedProvider: 'llamacpp',
    selectedModel: model,
  })
}

beforeEach(() => {
  seedServiceHub({
    models: {
      stopModel: vi.fn(),
      startModel: vi.fn(),
      getActiveModels: vi.fn().mockResolvedValue([]),
    } as unknown as ModelsService,
  })
  useThreads.setState({ currentThreadId: undefined })
  useAssistant.setState({
    assistants: [
      {
        id: 'writer',
        name: 'Writer',
        avatar: '✍️',
        instructions: 'Be terse.',
        parameters: { temperature: 0.7, top_p: 0.8 },
      } as unknown as Assistant,
    ],
    defaultAssistantId: 'writer',
    pendingAssistant: undefined,
  })
  seedLocalModel()
})

afterEach(async () => {
  await page.viewport(1280, 800)
})

const inside = (child: Element, parent: Element) => {
  const c = child.getBoundingClientRect()
  const p = parent.getBoundingClientRect()
  return c.top >= p.top - 0.5 && c.bottom <= p.bottom + 0.5
}

describe('Run settings panel header (Chromium)', () => {
  // QA on 2.2.21: the title, the close button and Reset to defaults scrolled
  // away with the settings, so closing the panel took a scroll back up.
  it.each(['16px', XL_FONT_SIZE])(
    'stays in view while the settings scroll / %s',
    async (fontSize) => {
      await page.viewport(1228, 600)
      setFontSize(fontSize)
      render(
        withTranslations(
          <div style={{ width: 300, height: 420 }}>
            <RunSettingsPanel onClose={vi.fn()} />
          </div>
        )
      )
      await settle()

      const panel = document.querySelector('aside')!
      const close = screen.getByRole('button', { name: 'Close run settings' })
      const reset = screen.getByRole('button', { name: /Reset to defaults/ })
      const title = screen.getByRole('heading', { name: 'Run settings' })
      const scroller = [...panel.querySelectorAll<HTMLElement>('*')].find(
        (el) => getComputedStyle(el).overflowY === 'auto'
      )!
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
      const before = [title, close, reset].map(
        (el) => el.getBoundingClientRect().top
      )

      scroller.scrollTop = scroller.scrollHeight
      await settle()

      expect(scroller.scrollTop).toBeGreaterThan(0)
      for (const [i, el] of [title, close, reset].entries()) {
        expect(el.getBoundingClientRect().top).toBeCloseTo(before[i], 0)
        expect(inside(el, panel)).toBe(true)
        // Nothing scrolled underneath covers the header.
        const box = el.getBoundingClientRect()
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2
        )
        expect(el.contains(hit)).toBe(true)
      }
      expectNoHorizontalOverflow(panel)
    }
  )
})
