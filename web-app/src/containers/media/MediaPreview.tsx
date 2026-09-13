/**
 * The generation preview.
 *
 * It renders a MATERIALISED asset, never a provider's own output reference.
 * The v1 version took the raw path and passed an `https:` one straight through
 * to the `src`, which is the CSP bug: `img-src` allows `https:` but `media-src`
 * does not, so a remote image rendered and a remote video was silently blocked
 * with nothing on screen to explain it.
 *
 * Decision Q4 chose to always materialise rather than widen `media-src` for the
 * whole app, so by the time anything reaches here the bytes are on disk and the
 * only correct source is the asset protocol. `toPreviewSrc` therefore has no
 * passthrough branch at all - a remote URL cannot be smuggled back in.
 *
 * The media kind comes from the asset's `media_type` rather than from sniffing
 * the file extension, so a task this build has never heard of degrades to an
 * honest "cannot preview" rather than a broken player.
 */
import { convertFileSrc } from '@tauri-apps/api/core'

import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MediaAsset } from '@/services/media/assets'

const frameClass =
  'relative flex min-h-[340px] flex-1 items-center justify-center overflow-hidden rounded-2xl border border-border/60 bg-muted/30 shadow-sm'

/**
 * A local path, as the asset protocol sees it.
 *
 * No branch for `https:`, `blob:` or `data:` - see the file comment. Anything
 * that is not a local path is a bug upstream in materialisation, and handing it
 * to `convertFileSrc` fails visibly rather than producing a remote request the
 * CSP would refuse anyway.
 */
function toPreviewSrc(path: string): string {
  return convertFileSrc(path)
}

type MediaPreviewProps = {
  asset: MediaAsset | null
}

export function MediaPreview({ asset }: MediaPreviewProps) {
  const { t } = useTranslation()
  if (!asset) {
    return (
      <div className={frameClass}>
        <div className="max-w-sm px-6 text-center">
          <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background text-lg shadow-sm">
            ✦
          </div>
          <p className="text-sm font-medium text-foreground">
            {t('media:preview.title', { defaultValue: 'Generation preview' })}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('media:preview.description', {
              defaultValue:
                'Your finished image or video will appear here without leaving Radium.',
            })}
          </p>
        </div>
      </div>
    )
  }

  const src = toPreviewSrc(asset.path)

  return (
    <div className={frameClass}>
      {asset.media_type === 'image' && (
        <img
          data-testid="media-image-preview"
          className="max-h-[58vh] w-full object-contain"
          src={src}
          alt={t('media:preview.alt', { defaultValue: 'Generated media' })}
        />
      )}

      {asset.media_type === 'video' && (
        <video
          data-testid="media-video-preview"
          className="max-h-[58vh] w-full bg-black object-contain"
          src={src}
          controls
        />
      )}

      {asset.media_type === 'audio' && (
        <audio
          data-testid="media-audio-preview"
          className="w-full px-6"
          src={src}
          controls
        />
      )}

      {(asset.media_type === 'model3d' || asset.media_type === 'unknown') && (
        <div
          data-testid="media-unknown-preview"
          className="max-w-sm px-6 text-center"
        >
          <p className="text-sm font-medium text-foreground">
            Preview not available
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            This output is a {asset.mime} file. It has been saved and can be
            opened from the media library.
          </p>
        </div>
      )}
    </div>
  )
}
