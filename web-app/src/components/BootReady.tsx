import { useEffect } from 'react'

import { bootReady, bootStep } from '@/lib/boot'

/**
 * Dismisses the boot screen once the layout around it has painted.
 *
 * Rendered inside ServiceHubProvider and ExtensionProvider, beside the layout,
 * so it mounts only when both have let their children through. Two animation
 * frames put the call after the first paint of that layout, not merely after
 * React committed it.
 */
export function BootReady({ reason = 'app drawn' }: { reason?: string }) {
  useEffect(() => {
    bootStep('layout', 'Almost ready…')
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => bootReady(reason))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [reason])

  return null
}
