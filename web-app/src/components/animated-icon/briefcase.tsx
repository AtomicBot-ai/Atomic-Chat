"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";

export interface BriefcaseIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface BriefcaseIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

// The handle lifts off the case on hover — a quiet "pick it up" beat for a
// row that only groups other entries, so it stays calmer than the plug icons.
const HANDLE_VARIANTS: Variants = {
  normal: { translateY: 0 },
  animate: {
    translateY: -1.5,
    transition: { duration: 0.3, ease: "easeInOut" },
  },
};

const LATCH_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: { duration: 0.4, ease: "easeInOut", delay: 0.1 },
  },
};

const BriefcaseIcon = forwardRef<BriefcaseIconHandle, BriefcaseIconProps>(
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
            d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"
            initial="normal"
            variants={HANDLE_VARIANTS}
          />
          <rect height="14" rx="2" width="20" x="2" y="6" />
          <path d="M22 13a18.15 18.15 0 0 1-20 0" />
          <motion.path
            animate={controls}
            d="M12 12h.01"
            initial="normal"
            variants={LATCH_VARIANTS}
          />
        </svg>
      </div>
    );
  }
);

BriefcaseIcon.displayName = "BriefcaseIcon";

export { BriefcaseIcon };
