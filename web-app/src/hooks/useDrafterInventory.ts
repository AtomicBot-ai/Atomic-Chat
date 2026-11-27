import { useCallback, useEffect, useState } from 'react'
import {
  drafters,
  drafterError,
  type DrafterInventory,
} from '@/services/drafters'

let cached: DrafterInventory | undefined
export function resetDrafterInventoryCache() {
  cached = undefined
}

export function useDrafterInventory(enabled = true) {
  const [value, setValue] = useState<DrafterInventory>(
    cached ?? {
      files: [],
      downloads: [],
    }
  )
  const [read, setRead] = useState(!enabled || cached !== undefined)
  const [error, setError] = useState('')
  const [version, refresh] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let interval = 1500
    const poll = async () => {
      try {
        const next = await drafters.list()
        if (active) {
          interval = next.downloads.length ? 800 : 5000
          cached = next
          setValue(next)
          setError('')
        }
      } catch (e) {
        if (active) setError(drafterError(e))
      }
      if (active) {
        setRead(true)
        timer = setTimeout(poll, interval)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [enabled, version])
  const reload = useCallback(() => refresh((n) => n + 1), [])
  return { value, error, read, refresh: reload }
}
