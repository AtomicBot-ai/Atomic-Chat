import * as React from "react"

const MOBILE_BREAKPOINT = 768

type MediaQueryCallback = (event: { matches: boolean; media: string }) => void

/**
 * Older versions of Safari (shipped with Catalina and before) do not support
 * addEventListener on MediaQueryList — they only implement the deprecated
 * addListener/removeListener pair. Use the same try/catch fallback pattern as
 * useMediaQuery.ts so the hook doesn't crash on those platforms.
 */
function attachMediaListener(
  query: MediaQueryList,
  callback: MediaQueryCallback
) {
  try {
    query.addEventListener("change", callback)
    return () => query.removeEventListener("change", callback)
  } catch (e) {
    console.warn(e)
    // @ts-expect-error — addListener is deprecated but still present on older browsers
    query.addListener(callback)
    return () =>
      // @ts-expect-error
      query.removeListener(callback)
  }
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    const cleanup = attachMediaListener(mql, onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return cleanup
  }, [])

  return !!isMobile
}
