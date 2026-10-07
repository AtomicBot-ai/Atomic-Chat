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
import {
  useEmbeddingModel,
  useLocalEmbeddingModel,
  type EmbeddingRunState,
} from '@/hooks/useEmbeddingModel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { LocalEmbeddingModel } from '@/lib/embedding/models'
import { cn } from '@/lib/utils'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'
import type { EmbeddingState } from '@/services/embedding/types'
import { useEmbeddingStore } from '@/stores/embedding-store'

/** GB the way the rest of the app renders them — binary, two decimals. */
function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2)
}

const STATE_LABEL: Record<EmbeddingState, string> = {
  disabled: 'settings:embedding.state.disabled',
  idle: 'settings:embedding.state.idle',
  starting: 'settings:embedding.state.starting',
  ready: 'settings:embedding.state.ready',
  restarting: 'settings:embedding.state.restarting',
  failed: 'settings:embedding.state.failed',
  unsupported: 'settings:embedding.state.unsupported',
}

/**
 * What a running model is doing, at the end of its facts line: starting,
 * failed, or served through the Local API Server (a link to the API page).
 * Nothing while it is stopped.
 */
function RunStatus({
  running,
  state,
}: Pick<EmbeddingRunState, 'running' | 'state'>) {
  const { t } = useTranslation()
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
            {t('settings:embedding.availableInApi')}
          </Link>
        ) : (
          t(STATE_LABEL[state])
        )}
      </span>
    </span>
  )
}

/** Start, or a red Stop once the model runs — as the chat models beside it. */
function StartStop({
  running,
  busy,
  startBlocked = false,
  activate,
  stop,
}: Pick<EmbeddingRunState, 'running' | 'busy' | 'activate' | 'stop'> & {
  startBlocked?: boolean
}) {
  const { t } = useTranslation()
  const anyBusy = useEmbeddingStore((s) => s.busy !== null)
  if (running) {
    return (
      <Button
        size="sm"
        variant="destructive"
        disabled={anyBusy}
        aria-label={t('settings:embedding.stop')}
        className="min-w-16 justify-center"
        onClick={() => void stop()}
      >
        {busy ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          t('settings:embedding.stop')
        )}
      </Button>
    )
  }
  return (
    <Button
      size="sm"
      disabled={anyBusy || startBlocked}
      aria-label={t('settings:embedding.start')}
      className="min-w-16 justify-center"
      onClick={() => void activate()}
    >
      {busy ? (
        <IconLoader2 size={16} className="animate-spin" />
      ) : (
        t('settings:embedding.start')
      )}
    </Button>
  )
}

/** The state of a catalog model, inline at the end of its facts line. */
export function EmbeddingModelStatus({
  model,
}: {
  model: EmbeddingCatalogModel
}) {
  const { running, state } = useEmbeddingModel(model)
  return <RunStatus running={running} state={state} />
}

/** The state of a llama.cpp model served as the embedding model. */
export function LocalEmbeddingModelStatus({
  model,
}: {
  model: LocalEmbeddingModel
}) {
  const { running, state } = useLocalEmbeddingModel(model)
  return <RunStatus running={running} state={state} />
}

/**
 * Start / stop for an embedding GGUF the user has as a llama.cpp model. It
 * is removed with the chat models, not here.
 */
export function LocalEmbeddingModelActions({
  model,
}: {
  model: LocalEmbeddingModel
}) {
  return <StartStop {...useLocalEmbeddingModel(model)} />
}

/**
 * Download / start / stop / remove for one catalog embedding model, as the
 * actions of its row. One model runs at a time: starting this one replaces
 * whichever ran before. With `onOpen`, an installed model offers Open in
 * place of Start / Stop: the Hub sends the user to where models are run.
 * `startBlocked`: the llama.cpp build is too old for the model, so Start
 * stays disabled until it is updated (the row says which build).
 */
const EmbeddingModelCard = memo(function EmbeddingModelCard({
  model,
  onOpen,
  startBlocked = false,
}: {
  model: EmbeddingCatalogModel
  onOpen?: () => void
  startBlocked?: boolean
}) {
  const { t } = useTranslation()
  const embedding = useEmbeddingModel(model)
  const {
    installed,
    downloading,
    progress,
    currentBytes,
    totalBytes,
    busy,
    download,
    cancelDownload,
    remove,
  } = embedding
  const anyBusy = useEmbeddingStore((s) => s.busy !== null)

  const [confirmRemove, setConfirmRemove] = useState(false)

  const percent = Math.round(progress * 100)

  const handleRemove = async () => {
    await remove()
    setConfirmRemove(false)
  }

  let actions
  if (downloading) {
    actions = (
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={cancelDownload}
          aria-label={t('common:cancelDownload')}
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
        <p
          className="text-right text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {t('settings:embedding.progress', {
            current: gb(currentBytes),
            total: gb(totalBytes),
          })}
        </p>
      </div>
    )
  } else if (!installed) {
    actions = (
      <Button variant="outline" size="sm" onClick={() => void download()}>
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
          aria-label={t('settings:embedding.remove')}
          onClick={() => setConfirmRemove(true)}
        >
          <IconTrash size={15} className="text-muted-foreground" />
        </Button>
      </div>
    )
  } else {
    actions = (
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={anyBusy}
          className="flex size-6 cursor-pointer items-center justify-center rounded transition-all duration-200 ease-in-out disabled:cursor-default disabled:opacity-50"
          title={t('settings:embedding.remove')}
          aria-label={t('settings:embedding.remove')}
          onClick={() => setConfirmRemove(true)}
        >
          <IconTrash size={18} className="text-muted-foreground" />
        </button>
        <div className="ml-2">
          <StartStop {...embedding} startBlocked={startBlocked} />
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
              {t('settings:embedding.removeTitle', { name: model.name })}
            </DialogTitle>
            <DialogDescription>
              {t('settings:embedding.removeDescription')}
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
              {t('settings:embedding.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

export default EmbeddingModelCard
