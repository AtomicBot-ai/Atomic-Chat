/**
 * Where generated images and video are saved.
 *
 * Shown on the Library page. Left on its default, files go under the app's data
 * folder; choosing a folder makes every new generation land there under a
 * readable name. Existing files are not moved.
 */

import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useMediaOutputStore } from '@/stores/media-output-store'
import { mediaDataFolder } from '@/stores/media-library-store'

export function MediaOutputSettings() {
  const { t } = useTranslation()
  const folder = useMediaOutputStore((state) => state.folder)
  const setFolder = useMediaOutputStore((state) => state.setFolder)
  const reset = useMediaOutputStore((state) => state.reset)

  const choose = async () => {
    const picked = await getServiceHub()
      .dialog()
      .open({ directory: true, defaultPath: folder || undefined })
    const chosen = Array.isArray(picked) ? picked[0] : picked
    if (chosen) setFolder(chosen)
  }

  const reveal = async () => {
    try {
      const target = folder || `${await mediaDataFolder()}/media/outputs`
      await getServiceHub().opener().openPath(target)
    } catch {
      toast.error(
        t('media:output.openFailed', {
          defaultValue: 'That folder does not exist yet. Generate something first.',
        })
      )
    }
  }

  return (
    <div
      data-testid="media-output-settings"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border/60 p-3 text-xs"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {t('media:output.title', { defaultValue: 'Save generations to' })}
        </p>
        <p className="mt-0.5 break-all text-muted-foreground">
          {folder ||
            t('media:output.default', {
              defaultValue: 'Default: the Radium data folder (media/outputs)',
            })}
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void choose()}>
          {t('media:output.change', { defaultValue: 'Change folder…' })}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void reveal()}>
          {t('media:output.open', { defaultValue: 'Open folder' })}
        </Button>
        {folder && (
          <Button size="sm" variant="secondary" onClick={reset}>
            {t('media:output.reset', { defaultValue: 'Use default' })}
          </Button>
        )}
      </div>
    </div>
  )
}
