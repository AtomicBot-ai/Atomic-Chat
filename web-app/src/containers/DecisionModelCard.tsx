import { memo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { IconLoader2, IconTrash, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { route } from '@/constants/routes'
import { useDecisionModel } from '@/hooks/useDecisionModel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'
import type { DecisionState } from '@/services/decision/types'
import { useDecisionStore } from '@/stores/decision-store'

/** GB the way the rest of the app renders them — binary, two decimals. */
function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2)
}

const STATE_LABEL: Record<DecisionState, string> = {
  disabled: 'settings:decision.state.disabled',
  idle: 'settings:decision.state.idle',
  starting: 'settings:decision.state.starting',
  ready: 'settings:decision.state.ready',
  restarting: 'settings:decision.state.restarting',
  failed: 'settings:decision.state.failed',
  unsupported: 'settings:decision.state.unsupported',
}

/**
 * What a running model is doing, at the end of its facts line: starting,
 * failed, or served through the Local API Server (a link to the API page).
 * Inline rather than on a line of its own, so the row keeps its height when
 * the model starts. Nothing while it is stopped.
 */
export function DecisionModelStatus({
  model,
}: {
  model: DecisionCatalogModel
}) {
  const { t } = useTranslation()
  const { running, state } = useDecisionModel(model)
  if (!running || !state || state === 'disabled') return null
  const served = state === 'ready' || state === 'idle'
  const failed = state === 'failed' || state === 'unsupported'
  return (
    <span className="inline-flex items-center">
      <span className="mx-1.5 text-muted-foreground/50" aria-hidden>
        ·
      </span>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 font-medium',
          served && 'text-emerald-600 dark:text-emerald-400',
          failed && 'text-destructive',
          !served && !failed && 'text-muted-foreground'
        )}
      >
        {served && (
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
        )}
        {!served && !failed && (
          <IconLoader2 size={12} className="animate-spin" />
        )}
        {served ? (
          <Link
            to={route.api.index}
            className="underline-offset-2 hover:underline"
          >
            {t('settings:decision.availableInApi')}
          </Link>
        ) : (
          t(STATE_LABEL[state])
        )}
      </span>
    </span>
  )
}

/**
 * Download / start / stop / remove for one decision model, as the actions of
 * its row. One model runs at a time: starting this one replaces whichever ran
 * before. Start and Stop look like the chat models' beside them; the state is
 * `DecisionModelStatus`, under the name. With `onOpen`, an installed model
 * offers Open in place of Start / Stop: the Hub sends the user to where
 * models are run. `startBlocked`: the engine build is too old for the model,
 * so Start stays disabled until it is updated (the row says which build).
 */
const DecisionModelCard = memo(function DecisionModelCard({
  model,
  onOpen,
  startBlocked = false,
}: {
  model: DecisionCatalogModel
  onOpen?: () => void
  startBlocked?: boolean
}) {
  const { t } = useTranslation()
  const {
    installed,
    downloading,
    progress,
    currentBytes,
    totalBytes,
    running,
    busy,
    download,
    cancelDownload,
    remove,
    activate,
    stop,
  } = useDecisionModel(model)
  const anyBusy = useDecisionStore((s) => s.busy !== null)

  const [confirmRemove, setConfirmRemove] = useState(false)

  const percent = Math.round(progress * 100)

  const handleRemove = async () => {
    await remove()
    setConfirmRemove(false)
  }

  // Every state fills the same w-24 slot at the button's height: the bytes
  // read out beside the size (DecisionModelDetailPanel), never under the
  // button, so starting a download does not move the panel.
  let actions
  if (downloading) {
    actions = (
      <Button
        variant="outline"
        size="sm"
        onClick={cancelDownload}
        aria-label={t('common:cancelDownload')}
        title={t('settings:decision.progress', {
          current: gb(currentBytes),
          total: gb(totalBytes),
        })}
        className="group relative w-24 justify-center overflow-hidden font-semibold"
      >
        <span
          className="absolute inset-y-0 left-0 z-0 bg-primary/20 transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
        <span className="relative z-10 tabular-nums group-hover:hidden">
          {percent}%
        </span>
        <IconX size={14} className="relative z-10 hidden group-hover:block" />
      </Button>
    )
  } else if (!installed) {
    actions = (
      <Button
        variant="outline"
        size="sm"
        className="w-24 justify-center"
        onClick={() => void download()}
      >
        {t('hub:download')}
      </Button>
    )
  } else if (onOpen) {
    actions = (
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="w-24 justify-center"
          onClick={onOpen}
        >
          {t('hub:open')}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-7"
          disabled={anyBusy}
          aria-label={t('settings:decision.remove')}
          onClick={() => setConfirmRemove(true)}
        >
          <IconTrash size={15} className="text-muted-foreground" />
        </Button>
      </div>
    )
  } else {
    const stopping = running && busy
    actions = (
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={anyBusy}
          className="flex size-6 cursor-pointer items-center justify-center rounded transition-all duration-200 ease-in-out disabled:cursor-default disabled:opacity-50"
          title={t('settings:decision.remove')}
          aria-label={t('settings:decision.remove')}
          onClick={() => setConfirmRemove(true)}
        >
          <IconTrash size={18} className="text-muted-foreground" />
        </button>
        <div className="ml-2">
          {running ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={anyBusy}
              aria-label={t('settings:decision.stop')}
              className="min-w-16 justify-center"
              onClick={() => void stop()}
            >
              {stopping ? (
                <IconLoader2 size={16} className="animate-spin" />
              ) : (
                t('settings:decision.stop')
              )}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={anyBusy || startBlocked}
              aria-label={t('settings:decision.start')}
              className="min-w-16 justify-center"
              onClick={() => void activate()}
            >
              {busy ? (
                <IconLoader2 size={16} className="animate-spin" />
              ) : (
                t('settings:decision.start')
              )}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      {actions}
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings:decision.removeTitle', { name: model.name })}
            </DialogTitle>
            <DialogDescription>
              {t('settings:decision.removeDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRemove(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void handleRemove()}
            >
              {t('settings:decision.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

export default DecisionModelCard
