import { useCallback, useEffect, useState } from 'react'
import { IconFolder } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ModelsFolderInfo } from '@/services/app/types'

/**
 * "Models folder" on the Models page: the folder downloaded models are saved
 * to and loaded from. The user can pick (or create, from the folder picker)
 * any folder, move the models they already have into it, or go back to the
 * default inside the data folder. The redirect itself lives in Rust
 * (src-tauri/src/core/app/models_folder.rs).
 */
export function ModelsFolderDialog() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const setProviders = useModelProvider((state) => state.setProviders)

  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<ModelsFolderInfo | undefined>()
  /** The folder picked but not applied yet; `null` means "the default". */
  const [pending, setPending] = useState<string | null | undefined>()
  const [moveExisting, setMoveExisting] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setInfo(await serviceHub.app().getModelsFolder())
  }, [serviceHub])

  useEffect(() => {
    if (open) {
      setPending(undefined)
      setMoveExisting(true)
      void load()
    }
  }, [open, load])

  const choose = async () => {
    const picked = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
      defaultPath: info?.path,
    })
    if (typeof picked === 'string' && picked !== info?.path) {
      setPending(picked)
    }
  }

  const apply = async () => {
    if (pending === undefined) return
    setBusy(true)
    try {
      // A loaded model keeps its file open, and Windows won't move an open file.
      await serviceHub.models().stopAllModels()
      const report = await serviceHub
        .app()
        .setModelsFolder(pending, moveExisting)

      if (report.failed.length > 0) {
        toast.warning(t('hub:modelsFolder.someNotMoved'), {
          description: report.failed
            .map(([name, reason]) => `${name}: ${reason}`)
            .join('\n'),
        })
      } else if (report.skipped.length > 0) {
        toast.warning(t('hub:modelsFolder.someSkipped'), {
          description: report.skipped.join(', '),
        })
      } else {
        toast.success(
          moveExisting && report.moved.length > 0
            ? t('hub:modelsFolder.movedCount', { count: report.moved.length })
            : t('hub:modelsFolder.changed')
        )
      }

      setProviders(await serviceHub.providers().getProviders())
      setOpen(false)
    } catch (error) {
      toast.error(t('hub:modelsFolder.failed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }

  const shownPath =
    pending === undefined
      ? info?.path
      : pending === null
        ? info?.default_path
        : pending

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start gap-2"
        onClick={() => setOpen(true)}
      >
        <IconFolder size={14} />
        {t('hub:modelsFolder.button')}
      </Button>

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('hub:modelsFolder.title')}</DialogTitle>
            <DialogDescription>
              {t('hub:modelsFolder.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            <div>
              <div className="mb-1 text-muted-foreground">
                {pending === undefined
                  ? t('hub:modelsFolder.current')
                  : t('hub:modelsFolder.new')}
                {(pending === null ||
                  (pending === undefined && info?.is_default)) && (
                  <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">
                    {t('hub:modelsFolder.default')}
                  </span>
                )}
              </div>
              <div
                className="rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs break-all"
                data-testid="models-folder-path"
              >
                {shownPath ?? '…'}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={choose}
                disabled={busy}
              >
                {t('hub:modelsFolder.choose')}
              </Button>
              {info && !info.is_default && pending !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPending(null)}
                  disabled={busy}
                >
                  {t('hub:modelsFolder.useDefault')}
                </Button>
              )}
            </div>

            {pending !== undefined && (
              <label className="flex items-start gap-3">
                <Switch
                  checked={moveExisting}
                  onCheckedChange={setMoveExisting}
                  disabled={busy}
                  aria-label={t('hub:modelsFolder.moveExisting')}
                />
                <span>
                  {t('hub:modelsFolder.moveExisting')}
                  <span className="block text-xs text-muted-foreground">
                    {moveExisting
                      ? t('hub:modelsFolder.moveExistingHint')
                      : t('hub:modelsFolder.leaveExistingHint')}
                  </span>
                </span>
              </label>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              {t('hub:modelsFolder.cancel')}
            </Button>
            <Button onClick={apply} disabled={busy || pending === undefined}>
              {busy
                ? t('hub:modelsFolder.working')
                : t('hub:modelsFolder.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
