import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { describe, expect, it, vi } from 'vitest'

import { DownloadPanel } from '@/containers/downloads/DownloadPanel'
import { OperationBarView } from '@/containers/managed-engine/ManagedEngineOperationBar'
import { UpdateBanner } from '@/containers/UpdateBanner'
import type { EnvironmentOperation } from '@/services/managed-environment/types'
import { setTheme, settle, withTranslations } from '@/test/layout'

const GB = 1024 ** 3

const operation = {
  operation_id: 'op-1',
  phase: 'pulling-image',
  target: { kind: 'runtime', engine_id: 'vllm' },
  progress: { unit: 'bytes', completed: 1.2 * GB, total: 7.9 * GB },
  pending_host_step: null,
} as unknown as EnvironmentOperation

/**
 * 2026-10-27 feedback: the download and update notifications landed on top of
 * each other. Every card in the corner shares one column, so any set of them
 * stacks without overlapping, right edges aligned, inside the window.
 */
describe.each(['light', 'dark'] as const)('corner column (%s)', (theme) => {
  it('stacks the download panel, an update offer and an engine setup without overlap', async () => {
    await page.viewport(1280, 900)
    setTheme(theme)

    render(
      withTranslations(
        <>
          <DownloadPanel
            items={[
              {
                id: 'unsloth/Qwen3-4B-GGUF',
                progress: 0.4,
                current: 1.2 * GB,
                total: 3 * GB,
                bytesPerSecond: 8 * 1024 ** 2,
                pausable: true,
              },
              {
                id: 'engine-update-llamacpp-upstream-b11500',
                kind: 'engine',
                name: 'llama.cpp',
                detail: 'b11500',
                progress: 0.1,
                current: 4_000_000,
                total: 40_000_000,
              },
            ]}
          />
          <UpdateBanner
            title="New llama.cpp update"
            fromVersion="b11463"
            toVersion="b11500"
            subtitle="38 MB download · No restart needed after update"
            remindLaterLabel="Remind me later"
            onRemindLater={vi.fn()}
            updateLabel="Update"
            onUpdate={vi.fn()}
            dismissLabel="Dismiss"
            onDismiss={vi.fn()}
            collapseLabel="Collapse"
            testId="engine-update-banner"
          />
          <OperationBarView
            operation={operation}
            windows={false}
            onDismiss={vi.fn()}
          />
        </>
      )
    )

    const cards = [
      screen.getByTestId('managed-operation-bar'),
      screen.getByTestId('engine-update-banner'),
      screen.getByRole('region'),
    ]
    await settle(document.body)

    const boxes = cards.map((card) => card.getBoundingClientRect())
    // Top to bottom in the column order, a gap between each pair.
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom + 8)
    }
    for (const box of boxes) {
      expect(box.right).toBeCloseTo(window.innerWidth - 16, 0)
      expect(box.width).toBeCloseTo(boxes[0].width, 0)
      expect(box.top).toBeGreaterThanOrEqual(0)
    }
    expect(boxes[2].bottom).toBeCloseTo(window.innerHeight - 16, 0)
  })
})
