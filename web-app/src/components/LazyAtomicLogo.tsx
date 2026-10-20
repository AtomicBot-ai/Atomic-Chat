import { useId } from 'react'
import { useReducedMotion } from 'motion/react'

/**
 * The empty chat's mark: the whole logo gently displaced by slow noise, so it
 * breathes without clipped edges or seams. With reduced motion it is the
 * still logo. The colour filter sits on the `<svg>` itself — WebKit ignores
 * CSS filter functions on SVG children such as `<image>`.
 */
export function LazyAtomicLogo() {
  // A valid fragment id whatever shape React gives `useId` (`:r0:`, `«r0»`).
  const id = `lazy-atomic-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const reduced = useReducedMotion()
  return (
    <svg
      viewBox="-8 -8 116 116"
      role="img"
      aria-label="Atomic Chat"
      data-testid="lazy-atomic-logo"
      className="lazy-atomic-logo mx-auto mb-6 size-28 overflow-visible brightness-0 dark:invert"
    >
      <defs>
        <filter
          id={id}
          x="-20%"
          y="-20%"
          width="140%"
          height="140%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.018"
            numOctaves={1}
            seed={5}
            result="wave"
          >
            {!reduced && (
              <animate
                attributeName="baseFrequency"
                values="0.018;0.025;0.018"
                dur="12s"
                repeatCount="indefinite"
              />
            )}
          </feTurbulence>
          <feDisplacementMap
            in="SourceGraphic"
            in2="wave"
            scale={reduced ? 0 : 5}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
      <g filter={`url(#${id})`}>
        <image href="/images/transparent-logo.png" width="100" height="100" />
      </g>
    </svg>
  )
}
