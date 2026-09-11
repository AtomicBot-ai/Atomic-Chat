import { useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { IconFolderOpen, IconLoader2, IconRefresh, IconTrash } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { useImageEngine } from '@/hooks/useImageEngine'
import {
  DEFAULT_IMAGE_IDLE_UNLOAD_MINUTES,
  IMAGE_IDLE_UNLOAD_OPTIONS,
  useImageSetting,
  type ImageEngineOverride,
  type ImageEvictPolicy,
} from '@/hooks/useImageSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { parseArtifactId } from '@/lib/diffusion/models'
import { formatBytes } from '@/lib/downloadFormat'
import { cn } from '@/lib/utils'
import { findFamily, findQuant } from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'

const gb = (bytes: number) => formatBytes(bytes, 1024 ** 3)

/**
 * Settings → Media. Three cards: the engine binary, the installed checkpoints
 * with the residency policies, and the output folder. Renders no page chrome,
 * matching `VoiceSettingsPanel`.
 */
export function MediaSettingsPanel() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const engine = useImageEngine()
  const status = useImageGenerationStore((state) => state.status)
  const catalog = useImageGenerationStore((state) => state.catalog)
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )
  const removeArtifact = useImageGenerationStore((state) => state.removeArtifact)
  const applyIdleSettings = useImageGenerationStore(
    (state) => state.applyIdleSettings
  )
  const refreshStatus = useImageGenerationStore((state) => state.refreshStatus)
  const openSetup = useImageGenerationStore((state) => state.openSetup)
  const generating = useImageGenerationStore((state) => state.generating)

  const {
    engineOverride,
    setEngineOverride,
    keepModelLoaded,
    setKeepModelLoaded,
    idleUnloadMinutes,
    setIdleUnloadMinutes,
    evictChatModel,
    setEvictChatModel,
  } = useImageSetting()

  const [removingId, setRemovingId] = useState<string | null>(null)
  const [changingDir, setChangingDir] = useState(false)

  const engineLabel = (value: ImageEngineOverride) =>
    value === 'auto'
      ? t('settings:media.engineAuto')
      : value === 'sd-cpp'
        ? 'stable-diffusion.cpp'
        : 'diffusers'

  const idleLabel = (minutes: number) =>
    minutes === 0
      ? t('settings:media.idleNever')
      : t('settings:media.idleMinutes', { minutes })

  const evictLabel = (value: ImageEvictPolicy) =>
    value === 'always'
      ? t('settings:media.evictAlways')
      : t('settings:media.evictWhenNeeded')

  const setIdle = (minutes: number) => {
    setIdleUnloadMinutes(minutes)
    void applyIdleSettings()
  }

  const setKeep = (value: boolean) => {
    setKeepModelLoaded(value)
    void applyIdleSettings()
  }

  const remove = async (id: string) => {
    setRemovingId(id)
    try {
      await removeArtifact(id)
    } catch (error) {
      toast.error(t('images:model.removeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRemovingId(null)
    }
  }

  const changeOutputDir = async () => {
    setChangingDir(true)
    try {
      const picked = await serviceHub.dialog().open({
        directory: true,
        defaultPath: status?.outputDir,
      })
      const dir = Array.isArray(picked) ? picked[0] : picked
      if (!dir) return
      await serviceHub.diffusion().setOutputDir(dir)
      await refreshStatus()
    } catch (error) {
      toast.error(t('settings:media.changeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setChangingDir(false)
    }
  }

  const resetDefaults = () => {
    setEngineOverride('auto')
    setKeepModelLoaded(false)
    setIdleUnloadMinutes(DEFAULT_IMAGE_IDLE_UNLOAD_MINUTES)
    setEvictChatModel('whenNeeded')
    void applyIdleSettings()
  }

  const artifactLabel = (id: string) => {
    const parsed = catalog ? parseArtifactId(id) : null
    if (!catalog || !parsed) return id
    const fam = findFamily(catalog, parsed.family)
    const quant = fam ? findQuant(fam, parsed.quantId) : undefined
    return fam && quant ? `${fam.name} · ${quant.label}` : id
  }

  return (
    <div className="flex flex-col gap-4" data-testid="media-settings-panel">
      <p className="text-muted-foreground">{t('settings:media.subtitle')}</p>

      <Card title={t('settings:media.engineTitle')}>
        <CardItem
          title={t('settings:media.engine')}
          description={
            engine.install.state === 'installed'
              ? t('settings:media.engineInstalled', {
                  tag: engine.install.tag,
                  backend: engine.install.backendId,
                })
              : engine.hostBackendId === null
                ? (engine.hostBackendReason ?? t('settings:media.engineUnsupported'))
                : t('settings:media.engineNotInstalled')
          }
          actions={
            engine.installing ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <IconLoader2 size={14} className="animate-spin" />
                {t('settings:media.installing')}
              </span>
            ) : engine.installed ? (
              <Button
                variant="outline"
                size="sm"
                disabled={generating}
                onClick={() => void engine.reinstall()}
              >
                <IconRefresh size={14} />
                {t('settings:media.reinstall')}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={engine.hostBackendId === null}
                onClick={() => void engine.startInstall()}
              >
                {t('settings:media.install')}
              </Button>
            )
          }
        />
        {engine.engineChoices.length > 1 && (
          <CardItem
            title={t('settings:media.engineOverride')}
            description={t('settings:media.engineOverrideDescription')}
            actions={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="w-48 justify-between">
                    {engineLabel(engineOverride)}
                    <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {(['auto', ...engine.engineChoices] as ImageEngineOverride[]).map(
                    (value) => (
                      <DropdownMenuItem
                        key={value}
                        className={cn(
                          'my-0.5 cursor-pointer',
                          engineOverride === value && 'bg-secondary-foreground/8'
                        )}
                        onClick={() => setEngineOverride(value)}
                      >
                        {engineLabel(value)}
                      </DropdownMenuItem>
                    )
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
        )}
      </Card>

      <Card title={t('settings:media.modelsTitle')}>
        {installedArtifacts.length === 0 ? (
          <CardItem
            title={t('settings:media.noModels')}
            actions={
              <Button variant="outline" size="sm" onClick={() => openSetup(2)}>
                {t('images:model.download')}
              </Button>
            }
          />
        ) : (
          installedArtifacts.map((artifact) => (
            <CardItem
              key={artifact.id}
              title={artifactLabel(artifact.id)}
              description={
                artifact.complete
                  ? t('images:model.sizeGb', { size: gb(artifact.bytes) })
                  : t('images:model.incomplete')
              }
              actions={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('settings:media.remove', {
                    name: artifactLabel(artifact.id),
                  })}
                  disabled={removingId === artifact.id || generating}
                  onClick={() => void remove(artifact.id)}
                >
                  {removingId === artifact.id ? (
                    <IconLoader2 size={16} className="animate-spin" />
                  ) : (
                    <IconTrash size={18} className="text-muted-foreground" />
                  )}
                </Button>
              }
            />
          ))
        )}
        <CardItem
          title={t('settings:media.keepLoaded')}
          description={t('settings:media.keepLoadedDescription')}
          actions={<Switch checked={keepModelLoaded} onCheckedChange={setKeep} />}
        />
        <CardItem
          title={t('settings:media.idleUnload')}
          description={t('settings:media.idleUnloadDescription')}
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-40 justify-between"
                  disabled={keepModelLoaded}
                >
                  {idleLabel(idleUnloadMinutes)}
                  <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {IMAGE_IDLE_UNLOAD_OPTIONS.map((minutes) => (
                  <DropdownMenuItem
                    key={minutes}
                    className={cn(
                      'my-0.5 cursor-pointer',
                      idleUnloadMinutes === minutes && 'bg-secondary-foreground/8'
                    )}
                    onClick={() => setIdle(minutes)}
                  >
                    {idleLabel(minutes)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        <CardItem
          title={t('settings:media.evictChat')}
          description={t('settings:media.evictChatDescription')}
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-40 justify-between">
                  {evictLabel(evictChatModel)}
                  <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {(['whenNeeded', 'always'] as ImageEvictPolicy[]).map((value) => (
                  <DropdownMenuItem
                    key={value}
                    className={cn(
                      'my-0.5 cursor-pointer',
                      evictChatModel === value && 'bg-secondary-foreground/8'
                    )}
                    onClick={() => setEvictChatModel(value)}
                  >
                    {evictLabel(value)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      </Card>

      <Card title={t('settings:media.outputTitle')}>
        <CardItem
          title={t('settings:media.outputFolder')}
          description={
            <span className="break-all font-mono text-xs" data-testid="media-output-dir">
              {status?.outputDir ?? '—'}
            </span>
          }
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!status?.outputDir}
                onClick={() =>
                  status?.outputDir &&
                  void serviceHub.opener().openPath(status.outputDir)
                }
              >
                <IconFolderOpen size={14} />
                {t('settings:media.openFolder')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={changingDir || generating}
                onClick={() => void changeOutputDir()}
              >
                {t('settings:media.change')}
              </Button>
            </div>
          }
        />
        <CardItem
          title={t('settings:media.resetDefaults')}
          description={t('settings:media.resetDefaultsDescription')}
          actions={
            <Button variant="outline" size="sm" onClick={resetDefaults}>
              {t('common:reset')}
            </Button>
          }
        />
      </Card>
    </div>
  )
}

export default MediaSettingsPanel
