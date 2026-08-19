import * as React from "react"
import { attachMediaListener } from "./useMediaQuery"

const MOBILE_BREAKPOINT = 768

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
