import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { toast } from 'sonner'
import { ToasterProvider } from '../ToasterProvider'

type PlatformFlag =
  | 'IS_MACOS'
  | 'IS_WINDOWS'
  | 'IS_LINUX'
  | 'IS_IOS'
  | 'IS_ANDROID'
const FLAGS: PlatformFlag[] = [
  'IS_MACOS',
  'IS_WINDOWS',
  'IS_LINUX',
  'IS_IOS',
  'IS_ANDROID',
]
const globals = globalThis as unknown as Record<PlatformFlag, boolean>

const onPlatform = (flag?: PlatformFlag) => {
  for (const name of FLAGS) globals[name] = name === flag
}

/** Show one toast and return the list sonner positions it in. */
const showToast = async () => {
  render(<ToasterProvider />)
  act(() => {
    toast('Saved')
  })
  let list: HTMLElement | null = null
  await waitFor(() => {
    list = document.querySelector<HTMLElement>('[data-sonner-toaster]')
    expect(list).not.toBeNull()
  })
  return list as unknown as HTMLElement
}

describe('ToasterProvider', () => {
  afterEach(() => {
    act(() => {
      toast.dismiss()
    })
    onPlatform()
  })

  it.each(['IS_MACOS', 'IS_WINDOWS', 'IS_LINUX'] as const)(
    'starts toasts below the window title bar row on %s',
    async (flag) => {
      onPlatform(flag)
      const list = await showToast()

      // 42px title bar row + the 8px gap.
      expect(list.style.getPropertyValue('--offset-top')).toBe('50px')
      expect(list.style.getPropertyValue('--offset-right')).toBe('8px')
    }
  )

  it.each([undefined, 'IS_IOS', 'IS_ANDROID'] as const)(
    'keeps toasts at the top edge on %s (web and mobile)',
    async (flag) => {
      onPlatform(flag)
      const list = await showToast()

      expect(list.style.getPropertyValue('--offset-top')).toBe('8px')
      expect(list.style.getPropertyValue('--offset-right')).toBe('8px')
    }
  )
})
