import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const chrome = vi.hoisted(() => ({ hasCustomWindowChrome: vi.fn() }))
vi.mock('@/lib/window-chrome', () => chrome)

// Captures what the provider asks the notification library for.
const toaster = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}))
vi.mock('@/components/ui/sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    toaster.props = props
    return <div data-testid="toaster" />
  },
}))

import { ToasterProvider } from '../ToasterProvider'

/**
 * The user (2026-09-14): Minimize, Maximize and Close did not work on some
 * pages. Notifications sit at the top right, above everything, and started
 * 8px from the top - on top of the 32px window strip and its buttons, so a
 * notification swallowed the clicks meant for them.
 */
describe('ToasterProvider', () => {
  beforeEach(() => {
    chrome.hasCustomWindowChrome.mockReset()
    toaster.props = null
  })

  it('keeps notifications below the window strip where Radium draws its own buttons', () => {
    chrome.hasCustomWindowChrome.mockReturnValue(true)

    render(<ToasterProvider />)

    expect(toaster.props?.position).toBe('top-right')
    // The strip is 32px tall (h-8); notifications start 8px below it.
    expect(toaster.props?.offset).toEqual({ top: 40, right: 8 })
  })

  it('keeps the usual spacing where the window has a native title bar', () => {
    chrome.hasCustomWindowChrome.mockReturnValue(false)

    render(<ToasterProvider />)

    expect(toaster.props?.position).toBe('top-right')
    expect(toaster.props?.offset).toEqual({ top: 8, right: 8 })
  })
})
