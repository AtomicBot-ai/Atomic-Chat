import { cn, getProviderLogo, getProviderTitle } from '@/lib/utils'
import { isMonochromeFamilyLogo } from '@/lib/model-logo'

const ProvidersAvatar = ({
  provider,
  className = 'size-4.5',
}: {
  provider: ProviderObject
  /** Sizing override. Applied to every branch so the letter fallback and the
   *  logo stay the same size. */
  className?: string
}) => {
  const logoSrc = getProviderLogo(provider.provider)

  if (logoSrc === undefined) {
    return (
      <div
        className={cn(
          'flex rounded-full border items-center justify-center',
          className
        )}
      >
        <p className="text-xs leading-0 capitalize">
          {getProviderTitle(provider.provider).charAt(0)}
        </p>
      </div>
    )
  }

  // Single-color marks (e.g. MiniMax) are drawn with `fill="currentColor"`,
  // so a plain <img> would paint them black and lose them on dark
  // backgrounds. Tint via CSS mask so they inherit the text color instead,
  // matching ModelLogo's rendering of the same mark.
  if (isMonochromeFamilyLogo(logoSrc)) {
    return (
      <span
        role="img"
        aria-label={`${provider.provider} - Logo`}
        className={cn('shrink-0 text-foreground', className)}
        style={{
          backgroundColor: 'currentColor',
          maskImage: `url(${logoSrc})`,
          WebkitMaskImage: `url(${logoSrc})`,
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
        }}
      />
    )
  }

  return (
    <img
      src={logoSrc}
      alt={`${provider.provider} - Logo`}
      className={cn('object-contain rounded-full', className)}
      style={{
        imageRendering: '-webkit-optimize-contrast',
      }}
      loading="eager"
      decoding="sync"
      draggable={false}
    />
  )
}

export default ProvidersAvatar
