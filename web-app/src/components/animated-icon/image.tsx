import type { Variants } from 'motion/react'
import { motion, useAnimation } from 'motion/react'
import type { HTMLAttributes } from 'react'
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'

import { cn } from '@/lib/utils'

export interface ImageIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

interface ImageIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number
}

const SUN_VARIANTS: Variants = {
  normal: { scale: 1, y: 0 },
  animate: {
    scale: [1, 1.35, 1],
    y: [0, -1, 0],
    transition: { duration: 0.5, ease: 'easeInOut' },
  },
}

const HILL_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: { duration: 0.5, ease: 'easeInOut' },
  },
}

const ImageIcon = forwardRef<ImageIconHandle, ImageIconProps>(
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
          <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
          <motion.circle
            animate={controls}
            cx="9"
            cy="9"
            r="2"
            variants={SUN_VARIANTS}
          />
          <motion.path
            animate={controls}
            d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"
            variants={HILL_VARIANTS}
          />
        </svg>
      </div>
    )
  }
)

ImageIcon.displayName = 'ImageIcon'

export { ImageIcon }
