import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingComponentProps } from '@janhq/core'

import { useAttachments } from '@/hooks/useAttachments'
import { Route as AttachmentsRoute } from '../attachments'

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock('@/containers/Card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardItem: ({
    title,
    actions,
  }: {
    title?: string
    actions?: React.ReactNode
  }) => (
    <div data-testid={`item-${title}`}>
      <span>{title}</span>
      {actions}
    </div>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: { component: unknown }) => config,
}))

/** The RAG extension's own definitions, as `settings.json` ships them. */
const DEFS = [
  {
    key: 'retrieval_limit',
    title: 'Top-K',
    controllerType: 'input',
    controllerProps: { value: 5, type: 'number', min: 1, max: 10, step: 1 },
  },
  {
    key: 'retrieval_threshold',
    title: 'Affinity',
    controllerType: 'input',
    controllerProps: { value: 0.3, type: 'number', min: 0, max: 1, step: 0.01 },
  },
] as unknown as SettingComponentProps[]

const field = (title: string) =>
  screen.getByTestId(`item-${title}`).querySelector('input') as HTMLInputElement

describe('Attachments settings', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAttachments.setState({
      settingsDefs: DEFS,
      retrievalLimit: 5,
      retrievalThreshold: 0.3,
      loadSettingsDefs: async () => true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['Top-K', '-1', '1'],
    ['Affinity', '1.5', '1'],
  ])(
    'shows the clamped %s once typing settles',
    async (title, typed, shown) => {
      const Page = (AttachmentsRoute as unknown as { component: React.FC })
        .component
      render(<Page />)

      fireEvent.change(field(title), { target: { value: typed } })
      expect(field(title).value).toBe(typed)

      await act(async () => {
        vi.advanceTimersByTime(600)
      })

      expect(field(title).value).toBe(shown)
    }
  )
})
