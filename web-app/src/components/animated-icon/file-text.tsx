import type { Variants } from 'motion/react'
import { motion, useAnimation } from 'motion/react'
import type { HTMLAttributes } from 'react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'

import { cn } from '@/lib/utils'

export interface FileTextIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

interface FileTextIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number
  active?: boolean
}

const LINE_VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
  },
  animate: (delay: number) => ({
    pathLength: [0, 1],
    opacity: [0.35, 1],
    transition: {
      delay,
      duration: 0.35,
      ease: 'easeInOut',
    },
  }),
}

const CORNER_VARIANTS: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 1.15, 1],
    transition: { duration: 0.4, ease: 'easeInOut' },
  },
}

const FileTextIcon = forwardRef<FileTextIconHandle, FileTextIconProps>(
  (
    { active, onMouseEnter, onMouseLeave, className, size = 28, ...props },
    ref
  ) => {
    const controls = useAnimation()
    const isControlledRef = useRef(false)

    useImperativeHandle(ref, () => {
      isControlledRef.current = true

      return {
        startAnimation: () => controls.start('animate'),
        stopAnimation: () => controls.start('normal'),
      }
    })

    useEffect(() => {
      if (active === undefined) return
      controls.start(active ? 'animate' : 'normal')
    }, [active, controls])

    const handleMouseEnter = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current || active !== undefined) {
          onMouseEnter?.(event)
        } else {
          controls.start('animate')
        }
      },
      [active, controls, onMouseEnter]
    )

    const handleMouseLeave = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current || active !== undefined) {
          onMouseLeave?.(event)
        } else {
          controls.start('normal')
        }
      },
      [active, controls, onMouseLeave]
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
            d="M14 3v4a1 1 0 0 0 1 1h4"
            style={{ transformOrigin: '16px 6px' }}
            variants={CORNER_VARIANTS}
          />
          <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
          <motion.path
            animate={controls}
            custom={0}
            d="M9 13h6"
            variants={LINE_VARIANTS}
          />
          <motion.path
            animate={controls}
            custom={0.1}
            d="M9 17h4"
            variants={LINE_VARIANTS}
          />
        </svg>
      </div>
    )
  }
)

FileTextIcon.displayName = 'FileTextIcon'

export { FileTextIcon }
