import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  HUGGINGFACE_LOGO_SRC,
  iconKeyLogoSrc,
  isMonochromeFamilyLogo,
  modelFamilyLogoSrc,
} from '@/lib/model-logo'

/**
 * Publisher logo for a model. Resolution order:
 *   1. an explicit `icon` key from the staff-picks manifest,
 *   2. the bundled brand logo for the model family (Gemma, Qwen, …),
 *   3. the `fallback` render: the Hugging Face mark for long-tail search
 *      results, or the first letter of the author/name everywhere else.
 *
 * No remote avatars are fetched: search results span hundreds of orgs whose
 * avatars are inconsistent in shape, contrast and size, and each one is an
 * extra network round-trip while scrolling.
 */
type ModelLogoProps = {
  author?: string
  name?: string
  /** Bundled icon key from the staff-picks manifest. */
  icon?: string
  /** What to draw when no logo matches. Defaults to the author's initial. */
  fallback?: 'letter' | 'huggingface'
  className?: string
}

export function ModelLogo({
  author,
  name,
  icon,
  fallback = 'letter',
  className,
}: ModelLogoProps) {
  const resolvedLogo = iconKeyLogoSrc(icon) ?? modelFamilyLogoSrc(name)
  const [failed, setFailed] = useState(false)
  const logoSrc =
    !failed && resolvedLogo
      ? resolvedLogo
      : !failed && fallback === 'huggingface'
        ? HUGGINGFACE_LOGO_SRC
        : null
  const letter = (author || name || '?').charAt(0).toUpperCase()
  // Single-color marks are drawn with `fill="currentColor"`, so an <img> would
  // paint them black and lose them on dark backgrounds. Tint via CSS mask so
  // they inherit the (theme-aware) text color, like the letter they replace.
  const mono = !!logoSrc && isMonochromeFamilyLogo(logoSrc)

  return (
    <div
      className={cn(
        'size-[46px] rounded-[10px] overflow-hidden shrink-0 flex items-center justify-center bg-secondary text-muted-foreground font-semibold text-sm border border-border dark:bg-input/30 dark:border-input',
        className
      )}
      title={author || ''}
    >
      {logoSrc ? (
        mono ? (
          <span
            role="img"
            aria-label={author || ''}
            className="size-full text-foreground"
            style={{
              backgroundColor: 'currentColor',
              maskImage: `url(${logoSrc})`,
              WebkitMaskImage: `url(${logoSrc})`,
              maskRepeat: 'no-repeat',
              WebkitMaskRepeat: 'no-repeat',
              maskPosition: 'center',
              WebkitMaskPosition: 'center',
              maskSize: '72%',
              WebkitMaskSize: '72%',
            }}
          />
        ) : (
          <img
            src={logoSrc}
            alt={author || ''}
            className="size-full rounded-md object-contain p-1"
            onError={() => setFailed(true)}
          />
        )
      ) : (
        letter
      )}
    </div>
  )
}
