import type { Variants } from 'motion/react'
import { motion, useAnimation } from 'motion/react'
import type { HTMLAttributes } from 'react'
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'

import { cn } from '@/lib/utils'

export interface SparklesIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

interface SparklesIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number
}

const LARGE_SPARKLE_VARIANTS: Variants = {
  normal: { rotate: 0, scale: 1 },
  animate: {
    rotate: 12,
    scale: [1, 1.18, 1],
    transition: { duration: 0.5, ease: 'easeInOut' },
  },
}

const SMALL_SPARKLE_VARIANTS: Variants = {
  normal: { scale: 1, opacity: 1 },
  animate: {
    scale: [1, 0.65, 1.2, 1],
    opacity: [1, 0.6, 1, 1],
    transition: { duration: 0.5, ease: 'easeInOut' },
  },
}

const SparklesIcon = forwardRef<SparklesIconHandle, SparklesIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation()
    const isControlledRef = useRef(false)

    useImperativeHandle(ref, () => {
      isControlledRef.current = true

      return {
        startAnimation: () => controls.start('animate'),
        stopAnimation: () => controls.start('normal'),
      }
    })

    const handleMouseEnter = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseEnter?.(event)
        } else {
          controls.start('animate')
        }
      },
      [controls, onMouseEnter]
    )

    const handleMouseLeave = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseLeave?.(event)
        } else {
          controls.start('normal')
        }
      },
      [controls, onMouseLeave]
    )

    return (
      <div
        className={cn(className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <svg
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <motion.path
            animate={controls}
            d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"
            variants={LARGE_SPARKLE_VARIANTS}
          />
          <motion.path
            animate={controls}
            d="M5 3v4M3 5h4M19 17v4M17 19h4"
            variants={SMALL_SPARKLE_VARIANTS}
          />
        </svg>
      </div>
    )
  }
)

SparklesIcon.displayName = 'SparklesIcon'

export { SparklesIcon }
