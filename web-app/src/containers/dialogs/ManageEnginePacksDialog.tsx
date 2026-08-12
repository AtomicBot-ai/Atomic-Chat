import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  IconFolderOpen,
  IconLoader,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getProviderTitle } from '@/lib/utils'
import type { InstalledBackendPack } from '@/hooks/useBackendUpdater'

/// One engine's slice of the packs dialog: the provider it belongs to plus the
/// three extension calls the dialog needs. The panel owns the
/// `useBackendUpdater` instances (hooks cannot be created per row here), so
/// they arrive as plain callbacks.
export type EnginePackSource = {
  provider: string
  listInstalledBackends: () => Promise<InstalledBackendPack[]>
  deleteBackend: (version: string, backend: string) => Promise<void>
  installBackend: (filePath: string) => Promise<void>
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  sources: EnginePackSource[]
  /// Called after a pack is installed or removed so the caller can re-read the
  /// engine's version list.
  onPacksChanged?: () => void | Promise<void>
}

type LoadedSource = {
  provider: string
  packs: InstalledBackendPack[]
}

export function ManageEnginePacksDialog({
  open,
  onOpenChange,
  sources,
  onPacksChanged,
}: Props) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState<LoadedSource[]>([])
  const [busyPack, setBusyPack] = useState<string | null>(null)
  const [installingFor, setInstallingFor] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const results = await Promise.all(
        sources.map(async (source) => ({
          provider: source.provider,
          packs: await source.listInstalledBackends().catch((err) => {
            console.warn(
              `[engine-packs] failed to list packs for ${source.provider}:`,
              err
            )
            return [] as InstalledBackendPack[]
          }),
        }))
      )
      setLoaded(results)
    } finally {
      setLoading(false)
    }
  }, [sources])

  useEffect(() => {
    if (!open) return
    void reload()
  }, [open, reload])

  const handleReveal = useCallback(
    async (path: string) => {
      try {
        await serviceHub.opener().revealItemInDir(path)
      } catch (err) {
        console.error('[engine-packs] failed to reveal pack:', err)
        toast.error(t('provider:packs.revealFailed'))
      }
    },
    [serviceHub, t]
  )

  const handleDelete = useCallback(
    async (source: EnginePackSource, pack: InstalledBackendPack) => {
      const id = `${source.provider}:${pack.version}/${pack.backend}`
      setBusyPack(id)
      try {
        await source.deleteBackend(pack.version, pack.backend)
        toast.success(t('provider:packs.deleted'), {
          description: `${pack.version} / ${pack.backend}`,
        })
        await reload()
        await onPacksChanged?.()
      } catch (err) {
        console.error('[engine-packs] failed to delete pack:', err)
        toast.error(t('provider:packs.deleteFailed'), {
          description: err instanceof Error ? err.message : undefined,
        })
      } finally {
        setBusyPack(null)
      }
    },
    [onPacksChanged, reload, t]
  )

  const handleInstall = useCallback(
    async (source: EnginePackSource) => {
      setInstallingFor(source.provider)
      try {
        const selectedFile = await serviceHub.dialog().open({
          multiple: false,
          directory: false,
          filters: [
            {
              name: 'Backend Archives',
              extensions: ['tar.gz', 'zip', 'gz'],
            },
          ],
        })
        if (!selectedFile || typeof selectedFile !== 'string') return

        await source.installBackend(selectedFile)
        toast.success(t('settings:backendInstallSuccess'))
        await reload()
        await onPacksChanged?.()
      } catch (err) {
        console.error('[engine-packs] failed to install pack:', err)
        toast.error(t('settings:backendInstallError'), {
          description: err instanceof Error ? err.message : undefined,
        })
      } finally {
        setInstallingFor(null)
      }
    },
    [onPacksChanged, reload, serviceHub, t]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('provider:packs.title')}</DialogTitle>
          <DialogDescription>
            {t('provider:packs.description')}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <IconLoader size={16} className="animate-spin" />
            <span>{t('provider:packs.loading')}</span>
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            {sources.map((source) => {
              const packs =
                loaded.find((entry) => entry.provider === source.provider)
                  ?.packs ?? []

              return (
                <div
                  key={source.provider}
                  className="rounded-lg bg-secondary/40 p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <h3 className="font-medium text-foreground">
                        {getProviderTitle(source.provider)}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t('provider:packs.installedCount', {
                          count: packs.length,
                        })}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleInstall(source)}
                      disabled={installingFor === source.provider}
                    >
                      <IconUpload size={14} className="text-muted-foreground" />
                      <span>
                        {installingFor === source.provider
                          ? t('provider:packs.installing')
                          : t('provider:packs.installFromFile')}
                      </span>
                    </Button>
                  </div>

                  {packs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('provider:packs.empty')}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {packs.map((pack) => {
                        const id = `${source.provider}:${pack.version}/${pack.backend}`
                        return (
                          <div
                            key={id}
                            className="flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-mono text-sm text-foreground">
                                {pack.version}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {pack.backend}
                                {pack.active
                                  ? ` · ${t('provider:packs.inUse')}`
                                  : ''}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleReveal(pack.path)}
                                title={pack.path}
                              >
                                <IconFolderOpen
                                  size={14}
                                  className="text-muted-foreground"
                                />
                                <span>{t('provider:packs.reveal')}</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                disabled={pack.active || busyPack === id}
                                title={
                                  pack.active
                                    ? t('provider:packs.inUseHint')
                                    : undefined
                                }
                                onClick={() => handleDelete(source, pack)}
                              >
                                {busyPack === id ? (
                                  <IconLoader
                                    size={14}
                                    className="animate-spin"
                                  />
                                ) : (
                                  <IconTrash size={14} />
                                )}
                                <span>{t('provider:packs.delete')}</span>
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
