import { cn } from '@/lib/utils'

/** Google's multicolour "G", as its sign-in branding guidelines require. */
function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={className}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

/**
 * Google's own "filled blue" sign-in button: brand blue, white label, the
 * colour logo on a white disc. Brand colours stay the same in light and dark
 * themes, as Google's guidelines ask.
 */
export function GoogleSignInButton({
  label,
  disabled,
  onClick,
  className,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative flex h-[var(--control-height-large,2rem)] w-full cursor-pointer items-center justify-center rounded-full bg-[#1a73e8] px-10 text-sm font-medium text-white transition-colors hover:bg-[#1765cc] active:bg-[#185abc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60',
        className
      )}
    >
      <span className="absolute top-[3px] bottom-[3px] left-[3px] flex aspect-square items-center justify-center rounded-full bg-white">
        <GoogleLogo className="size-4" />
      </span>
      <span className="truncate">{label}</span>
    </button>
  )
}
