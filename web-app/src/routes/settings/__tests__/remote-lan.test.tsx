import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { control, sectionServer } = vi.hoisted(() => ({
  control: { status: 'stopped' },
  sectionServer: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => control,
}))

vi.mock('@/containers/remote-lan/RemoteLanSection', () => ({
  RemoteLanSection: ({ server }: { server: unknown }) => {
    sectionServer(server)
    return <section aria-label="remote-lan" />
  },
}))

import { RemoteAccessPage } from '../remote-lan'

describe('/settings/remote-lan', () => {
  it('is the Server section’s Remote access page, with one control for both cards', () => {
    render(<RemoteAccessPage />)

    expect(
      screen.getByRole('heading', { name: 'settings:remoteLan.pageTitle' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'remote-lan' })
    ).toBeInTheDocument()
    expect(sectionServer).toHaveBeenCalledWith(control)
  })
})
