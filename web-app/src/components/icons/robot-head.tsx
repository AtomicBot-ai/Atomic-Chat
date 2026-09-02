import type { SVGProps } from 'react'

type RobotHeadIconProps = Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> & {
  size?: number
}

/**
 * Agent avatar: just the robot's head, so it still reads at the 16px the
 * composer chip gives it — the stock full-body robot spends two thirds of its
 * box on legs and arms and turns to mush at that size.
 */
export function RobotHeadIcon({ size = 24, ...props }: RobotHeadIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="3.5" r="1.75" />
      <path d="M12 5.25v2.25" />
      <rect x="5" y="7.5" width="14" height="13" rx="4" />
      <path d="M5 11.5a3 3 0 0 0 0 6" />
      <path d="M19 11.5a3 3 0 0 1 0 6" />
      <path d="M9.5 13v.01" />
      <path d="M14.5 13v.01" />
      <path d="M10 17h4" />
    </svg>
  )
}
