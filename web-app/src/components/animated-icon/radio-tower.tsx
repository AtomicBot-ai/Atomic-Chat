"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface RadioTowerIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface RadioTowerIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

// The signal arcs fan outwards on hover, reading as "serving traffic".
const WAVE_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      duration: 0.4,
      ease: "easeInOut",
      delay: custom * 0.12,
      opacity: { delay: custom * 0.12 },
    },
  }),
};

const RadioTowerIcon = forwardRef<RadioTowerIconHandle, RadioTowerIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;
      return {
        startAnimation: () => controls.start("animate"),
        stopAnimation: () => controls.start("normal"),
      };
    });

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseEnter?.(e);
        } else {
          controls.start("animate");
        }
      },
      [controls, onMouseEnter]
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseLeave?.(e);
        } else {
          controls.start("normal");
        }
      },
      [controls, onMouseLeave]
    );

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
            custom={0}
            d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9"
            initial="normal"
            variants={WAVE_VARIANTS}
          />
          <motion.path
            animate={controls}
            custom={1}
            d="M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"
            initial="normal"
            variants={WAVE_VARIANTS}
          />
          <circle cx="12" cy="9" r="2" />
          <motion.path
            animate={controls}
            custom={1}
            d="M16.2 4.8c2 2 2.26 5.11.8 7.47"
            initial="normal"
            variants={WAVE_VARIANTS}
          />
          <motion.path
            animate={controls}
            custom={0}
            d="M19.1 1.9a9.96 9.96 0 0 1 0 14.1"
            initial="normal"
            variants={WAVE_VARIANTS}
          />
          <path d="M9.5 18h5" />
          <path d="m8 22 4-11 4 11" />
        </svg>
      </div>
    );
  }
);

RadioTowerIcon.displayName = "RadioTowerIcon";

export { RadioTowerIcon };
