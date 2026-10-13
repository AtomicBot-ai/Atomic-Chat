/**
 * The media library, at /media/library.
 *
 * The filename is `media_.library.tsx`, not `media/library.tsx`. The trailing
 * underscore is TanStack Router's opt-out from the parent layout: written as
 * `media/library.tsx`, this route would nest inside `routes/media.tsx` and
 * render nothing unless that file grew an `<Outlet />`. `routes/media.tsx` is
 * one of the files frozen by the selective v2.0.32 protected surface, so
 * editing it would mean a guard re-baseline and the user's authorisation for a
 * change that buys nothing. The underscore gives the same URL and leaves the
 * protected file alone.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { MediaLibrary } from '@/containers/media/MediaLibrary'
import { MediaOutputSettings } from '@/containers/media/MediaOutputSettings'
import { extractLastFrameDataUrl } from '@/containers/media/videoLastFrame'
import { route } from '@/constants/routes'
import { BUILTIN_ENGINE_PROVIDER_ID } from '@/constants/mediaProviders'
import { setPendingMediaReRun } from '@/services/media/rerun'
import type { MediaAsset } from '@/services/media/assets'

export const Route = createFileRoute('/media_/library')({
  component: MediaLibraryRoute,
})

function MediaLibraryRoute() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const handleContinue = async (asset: MediaAsset) => {
    // V1 is local-first: only the built-in engine conditions on a start frame.
    // Cloud image-to-video (fal/Replicate) is a separate follow-up.
    if (asset.provenance.provider_id !== BUILTIN_ENGINE_PROVIDER_ID) {
      toast.error(
        t('media:asset.continueUnsupported', {
          defaultValue:
            'Continue works with the built-in engine for now.',
        })
      )
      return
    }

    try {
      const initImage = await extractLastFrameDataUrl(asset.path, asset.mime)
      const params: Record<string, unknown> = {
        ...asset.provenance.params,
        init_image: initImage,
      }
      // The previous clip's last frame is now the next clip's first frame; the
      // old end frame no longer applies, and the seed is dropped so the next
      // clip is a new generation rather than a repeat.
      delete params.end_image
      delete params.seed
      setPendingMediaReRun({
        provider_id: asset.provenance.provider_id,
        model_id: asset.provenance.model_id,
        task: asset.provenance.task,
        params,
      })
      void navigate({ to: route.media })
    } catch (error) {
      toast.error(
        t('media:asset.continueFailed', {
          defaultValue: 'Could not read the last frame: {{message}}',
          message: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto">
      <HeaderPage>
        <span>{t('media:library.title', { defaultValue: 'Library' })}</span>
      </HeaderPage>
      <div className="p-4">
        <MediaOutputSettings />
        <MediaLibrary
          onReRun={(request) => {
            // Handed over rather than executed here: the studio owns submission,
            // and duplicating that here would be a second code path to keep in
            // step with the first.
            setPendingMediaReRun(request)
            void navigate({ to: route.media })
          }}
          onContinue={handleContinue}
        />
      </div>
    </div>
  )
}
