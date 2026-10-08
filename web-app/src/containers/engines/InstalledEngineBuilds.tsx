import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { deleteEngineBuild } from '@/services/engines/core'
import type { EngineBuild, EngineId } from '@/services/engines/types'
import { activateEngineBuildThroughCore } from '@/services/engines/update'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

type CoreRefusal = { code?: unknown; message?: unknown }

const key = (build: EngineBuild) => `${build.version}/${build.variant}`

/**
 * The builds of one engine installed on this computer, from the core's
 * versions answer (spec `engine-lifecycle-desktop`, "Список установленных
 * сборок с удалением"): version, variant, where it came from, which is active
 * and which something runs from.
 *
 * "Remove" asks first and goes to the core (`DELETE /engines/:e/builds/…`);
 * it is unavailable, with the reason beside it, for the active build, one that
 * came with the installer and one in use. "Make active" exists only where the
 * client picks the build (`active_choice: client`, llama.cpp): the core
 * switches and unloads this provider's models, which the list warns about when
 * some are loaded. The list is asked again after each action; `engine:changed`
 * keeps it current otherwise.
 */
export function InstalledEngineBuilds({
  engine,
  hasLoadedModels = false,
}: {
  engine: EngineId
  /** The provider has loaded models, which "Make active" unloads. */
  hasLoadedModels?: boolean
}) {
  const { t } = useTranslation()
  const versions = useEngineVersionsStore((state) => state.engines[engine])
  const [confirming, setConfirming] = useState<EngineBuild | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!versions || versions.builds.length === 0) return null
  const clientPicks = versions.active_choice === 'client'

  const describeRefusal = (refusal: unknown, fallback: string): string => {
    const { code, message } = (refusal ?? {}) as CoreRefusal
    const text = typeof message === 'string' ? message : String(refusal)
    if (code === 'BACKEND_IN_USE')
      return t('settings:engineBuilds.error.inUse', { message: text })
    if (code === 'INVALID_REQUEST')
      return t('settings:engineBuilds.error.invalid', { message: text })
    return `${fallback}: ${text}`
  }

  const remove = async (build: EngineBuild) => {
    setConfirming(null)
    setBusy(key(build))
    setError(null)
    try {
      await deleteEngineBuild(engine, build.version, build.variant)
    } catch (refusal) {
      setError(
        describeRefusal(refusal, t('settings:engineBuilds.removeFailed'))
      )
    } finally {
      setBusy(null)
      void useEngineVersionsStore.getState().refresh()
    }
  }

  const activate = async (build: EngineBuild) => {
    setBusy(key(build))
    setError(null)
    try {
      await activateEngineBuildThroughCore(engine, build.version, build.variant)
    } catch (refusal) {
      setError(
        describeRefusal(refusal, t('settings:engineBuilds.activateFailed'))
      )
    } finally {
      setBusy(null)
      void useEngineVersionsStore.getState().refresh()
    }
  }

  return (
    <div
      className="mt-3 flex flex-col gap-2"
      data-testid={`engine-builds-${engine}`}
    >
      <div className="text-xs font-medium text-muted-foreground">
        {t('settings:engineBuilds.title')}
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md border">
        {versions.builds.map((build) => {
          const working = busy === key(build)
          return (
            <li
              key={key(build)}
              data-testid={`engine-build-${build.version}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <code className="truncate font-mono text-foreground">
                  {build.version}
                </code>
                <span className="truncate text-muted-foreground">
                  {build.variant}
                </span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">
                  {t(`settings:engineBuilds.origin.${build.origin}`)}
                </span>
                {build.active && (
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                    {t('settings:engineBuilds.active')}
                  </span>
                )}
                {build.in_use && (
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                    {t('settings:engineBuilds.inUse')}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {!build.removable && build.not_removable_reason && (
                  <span className="text-[11px] text-muted-foreground">
                    {t(
                      `settings:engineBuilds.notRemovable.${build.not_removable_reason}`
                    )}
                  </span>
                )}
                {clientPicks && !build.active && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void activate(build)}
                  >
                    {t('settings:engineBuilds.makeActive')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!build.removable || busy !== null}
                  aria-busy={working}
                  onClick={() => setConfirming(build)}
                >
                  {t('settings:engineBuilds.remove')}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
      {clientPicks && hasLoadedModels && (
        <p className="text-[11px] text-muted-foreground">
          {t('settings:engineBuilds.unloadWarning')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings:engineBuilds.confirmRemoveTitle')}
            </DialogTitle>
            <DialogDescription>
              {confirming &&
                t('settings:engineBuilds.confirmRemoveDescription', {
                  build: key(confirming),
                })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="link"
              size="sm"
              onClick={() => setConfirming(null)}
            >
              {t('settings:engineBuilds.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => confirming && void remove(confirming)}
            >
              {t('settings:engineBuilds.confirmRemove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
