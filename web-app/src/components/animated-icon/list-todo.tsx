import type { Variants } from 'motion/react'
import { motion, useAnimation } from 'motion/react'
import type { HTMLAttributes } from 'react'
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'

import { cn } from '@/lib/utils'

export interface ListTodoIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

interface ListTodoIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number
}

const CHECK_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [0, 1],
    opacity: [0.4, 1],
    transition: { duration: 0.35, ease: 'easeInOut' },
  },
}

const BOX_VARIANTS: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 0.8, 1.1, 1],
    transition: { duration: 0.4, ease: 'easeInOut' },
  },
}

const LINE_VARIANTS: Variants = {
  normal: { x: 0 },
  animate: {
    x: [0, 1.5, 0],
    transition: { duration: 0.4, ease: 'easeInOut' },
  },
}

const ListTodoIcon = forwardRef<ListTodoIconHandle, ListTodoIconProps>(
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
            d="m3 6 2 2 4-4"
            variants={CHECK_VARIANTS}
          />
          <motion.path
            animate={controls}
            d="M13 6h8"
            variants={LINE_VARIANTS}
          />
          <motion.rect
            animate={controls}
            height="6"
            rx="1"
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            variants={BOX_VARIANTS}
            width="6"
            x="3"
            y="14"
          />
          <motion.path
            animate={controls}
            d="M13 17h8"
            variants={LINE_VARIANTS}
          />
        </svg>
      </div>
    )
  }
)

ListTodoIcon.displayName = 'ListTodoIcon'

export { ListTodoIcon }
