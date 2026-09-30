import { act, render, screen, within } from '@testing-library/react'
import { page, userEvent } from '@vitest/browser/context'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentApprovalModeSelect } from './AgentApprovalModeSelect'
import type { AgentApprovalMode } from '@/hooks/useAgentMode'
import chat from '@/locales/en/chat.json'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameWidth,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  type Theme,
} from '@/test/layout'

const copy = chat.agentApprovals
const cases = [1280, 1024, 320].flatMap((width) =>
  ['16px', '18px', '20px'].flatMap((fontSize) =>
    (['light', 'dark'] as const).flatMap((theme) =>
      (['manual', 'skip'] as const).map((mode) => ({
        width,
        fontSize,
        theme,
        mode,
      }))
    )
  )
)

afterEach(async () => {
  await page.viewport(1280, 800)
})

async function openMenu({
  width,
  fontSize,
  theme,
  mode,
}: {
  width: number
  fontSize: string
  theme: Theme
  mode: AgentApprovalMode
}) {
  await page.viewport(width, 800)
  setFontSize(fontSize)
  setTheme(theme)
  render(
    // Reserve the open sidebar's 256px at desktop sizes and anchor the menu
    // near the bottom of the composer, as it appears in the app.
    <div style={{ marginLeft: width >= 1024 ? 256 : 0, padding: 16 }}>
      <div style={{ paddingTop: 600 }}>
        <AgentApprovalModeSelect
          mode={mode}
          onChange={() => {}}
          menuTitle={copy.menuTitle}
          manualSelectedLabel={copy.manualSelected}
          manualLabel={copy.manual}
          manualDescription={copy.manualDescription}
          skipSelectedLabel={copy.skipSelected}
          skipLabel={copy.skip}
          skipDescription={copy.skipDescription}
          skipConfirmTitle={copy.skipConfirmTitle}
          skipConfirmBody={copy.skipConfirmBody}
          skipConfirmCancel={copy.skipConfirmCancel}
          skipConfirmAccept={copy.skipConfirmAccept}
        />
      </div>
    </div>
  )
  const trigger = screen.getByRole('button', {
    name: mode === 'manual' ? copy.manualSelected : copy.skipSelected,
  })
  await act(async () => {
    await userEvent.click(trigger)
  })
  const menu = screen.getByRole('menu')
  await act(async () => {
    await settle()
  })
  return { menu, trigger }
}

function lineCount(element: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(element)
  return new Set(
    [...range.getClientRects()]
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => Math.round(rect.top))
  ).size
}

describe('Approval menu geometry (Chromium)', () => {
  it.each(cases)(
    '$width px / $fontSize / $theme / $mode: readable copy and aligned options',
    async (testCase) => {
      const { menu, trigger } = await openMenu(testCase)
      const bounds = menu.getBoundingClientRect()
      if (testCase.width >= 1024) {
        expect.soft(bounds.width).toBeGreaterThanOrEqual(400)
        expect.soft(bounds.width).toBeLessThanOrEqual(416)
        expect(bounds.left).toBeCloseTo(trigger.getBoundingClientRect().left, 0)
      } else {
        expect(bounds.width).toBeLessThanOrEqual(testCase.width - 32)
      }
      expect(bounds.left).toBeGreaterThanOrEqual(16)
      expect(bounds.right).toBeLessThanOrEqual(testCase.width - 16)
      expectNoHorizontalOverflow(menu)
      expectNoHorizontalOverflow(document.body)
      // Do not let overflow-x-hidden mask text clipping.
      expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth)

      const rows = within(menu).getAllByRole('menuitem')
      expect(rows).toHaveLength(2)
      expectSameWidth(rows)
      const iconLefts: number[] = []
      const checkLefts: number[] = []
      for (const [index, row] of rows.entries()) {
        const title = within(row).getByText(
          index === 0 ? copy.manual : copy.skip
        )
        const description = within(row).getByText(
          index === 0 ? copy.manualDescription : copy.skipDescription
        )
        const textBlock = title.parentElement!
        const [icon, check] = row.querySelectorAll('svg')
        expect(icon).toBeDefined()
        expect(check).toBeDefined()
        expectOneLine(title)
        if (testCase.width >= 1024) {
          expect.soft(lineCount(description)).toBeGreaterThan(0)
          expect.soft(lineCount(description)).toBeLessThanOrEqual(2)
        }
        expect(description.scrollHeight).toBeLessThanOrEqual(
          description.clientHeight + 1
        )
        expectVerticallyCentered(icon, textBlock)
        expectVerticallyCentered(check, textBlock)
        expect(icon.getBoundingClientRect().width).toBe(16)
        expect(check.getBoundingClientRect().width).toBe(16)
        const selected = (index === 0) === (testCase.mode === 'manual')
        expect(getComputedStyle(check).visibility).toBe(
          selected ? 'visible' : 'hidden'
        )
        iconLefts.push(icon.getBoundingClientRect().left)
        checkLefts.push(check.getBoundingClientRect().left)
        expect(textBlock.getBoundingClientRect().left).toBeGreaterThan(
          icon.getBoundingClientRect().right
        )
        expect(textBlock.getBoundingClientRect().right).toBeLessThan(
          check.getBoundingClientRect().left
        )
      }
      expect(iconLefts[0]).toBe(iconLefts[1])
      expect(checkLefts[0]).toBe(checkLefts[1])
    }
  )
})
