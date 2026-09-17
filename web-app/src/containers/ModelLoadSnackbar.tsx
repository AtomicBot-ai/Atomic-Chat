/**
 * The model loading snackbar (ATO-530).
 *
 * A load the user is waiting on gets a snackbar in the top-right corner: what
 * is starting, the step it is on, a Cancel, and a dismiss. When the model is
 * up it turns into "Model ready" for a few seconds; a load that fails
 * or is cancelled simply takes it away — the failure has its own toast and
 * the status strip above the composer.
 *
 * It is a sonner toast rather than a fixed element of its own, so it stacks
 * with the other top-right toasts (the load error, the OOM-retry notice)
 * instead of landing on top of them; the update banners own the bottom-right
 * corner. Everything it says is read from `useInferenceStatus`, the same
 * state the status strip and the model dot read (ATO-535).
 */
import { useEffect, useRef, type ReactNode } from 'react'

import { IconCircleCheckFilled, IconLoader2, IconX } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useInferenceStatus } from '@/hooks/useInferenceStatus'
import { useServiceHub } from '@/hooks/useServiceHub'
import i18n from '@/i18n/setup'
import { modelLoadStageKey, type InferenceStatus } from '@/lib/inference-status'
import type { ServiceHub } from '@/services'
import { cancelModelLoad } from '@/utils/switchModel'

/** How long "Model ready" stays up before it clears itself. */
export const LOADED_SNACKBAR_MS = 3000

const isLoading = (status: InferenceStatus) =>
  status.phase === 'starting' || status.phase === 'restarting'

let toastSeq = 0

/**
 * Drives the toast; renders nothing itself. Mounted once at the root.
 */
export function ModelLoadSnackbar() {
  const status = useInferenceStatus()
  const serviceHub = useServiceHub()
  const loading = isLoading(status)
  const { phase, modelId } = status
  const latestStatus = useRef(status)
  latestStatus.current = status

  /** The toast on screen, and which of its two faces it is showing. */
  const shownRef = useRef<{ id: string; face: 'loading' | 'loaded' } | null>(
    null
  )
  /** The user closed the snackbar of the load still in flight. */
  const closedDuringLoadRef = useRef(false)

  useEffect(() => {
    const hide = () => {
      if (shownRef.current) toast.dismiss(shownRef.current.id)
      shownRef.current = null
    }

    if (loading) {
      if (closedDuringLoadRef.current || shownRef.current?.face === 'loading') {
        return
      }
      // A fresh id per showing: sonner keeps a dismissed toast around for its
      // exit animation, and re-using that id would fold the new one into it.
      hide()
      const id = `model-load-${++toastSeq}`
      const close = () => {
        if (isLoading(latestStatus.current)) closedDuringLoadRef.current = true
        if (shownRef.current?.id === id) shownRef.current = null
        toast.dismiss(id)
      }
      toast.custom(
        () => <ModelLoadToast serviceHub={serviceHub} onClose={close} />,
        {
          id,
          duration: Infinity,
          // Its own × is the only way to close it: sonner's swipe and close
          // paths cannot tell the user apart from a programmatic dismiss.
          dismissible: false,
          // The success face uses Sonner's normal width. Keep the loading
          // face's room for progress and Cancel, and the same toast lifecycle.
          className: 'has-[[data-face=loaded]]:w-[var(--width)]!',
          // The Toaster's default padding and background are for its own
          // layout; this one draws its own card.
          style: {
            padding: 0,
            background: 'transparent',
            border: 'none',
            // Leave room for enlarged text while staying inside narrow windows.
            width: '30rem',
            maxWidth: 'calc(100vw - 2rem)',
            right: 0,
          },
        }
      )
      shownRef.current = { id, face: 'loading' }
      return
    }

    // The load is over, whichever way it went.
    closedDuringLoadRef.current = false

    if (shownRef.current?.face === 'loading' && phase === 'ready') {
      shownRef.current = { ...shownRef.current, face: 'loaded' }
    }
    if (shownRef.current?.face === 'loaded' && phase === 'ready') {
      const timer = setTimeout(hide, LOADED_SNACKBAR_MS)
      return () => clearTimeout(timer)
    }
    hide()
  }, [loading, phase, modelId, serviceHub])

  useEffect(
    () => () => {
      if (shownRef.current) toast.dismiss(shownRef.current.id)
    },
    []
  )

  return null
}

/**
 * The card inside the toast. Reads the status live, so the load's steps and
 * its success show up without the toast being re-created.
 *
 * Sonner renders it under the Toaster, outside the translation and most other
 * providers — hence `i18n.t` and a service hub handed in, not hooks.
 */
export function ModelLoadToast({
  serviceHub,
  onClose,
}: {
  serviceHub: ServiceHub
  onClose: () => void
}) {
  const t = i18n.t.bind(i18n)
  const status = useInferenceStatus()

  // Once the load is over the toast is on its way out; keep what it last said
  // rather than flash a third state during the exit animation.
  const lastShown = useRef(status)
  if (isLoading(status) || status.phase === 'ready') lastShown.current = status
  const shown = lastShown.current

  if (shown.phase === 'ready') {
    return (
      <SnackbarCard
        testId="model-load-snackbar"
        face="loaded"
        dismissLabel={t('common:modelLoad.dismiss')}
        onClose={onClose}
        icon={
          <IconCircleCheckFilled
            size={20}
            className="shrink-0 text-green-600"
          />
        }
        title={t('common:modelLoad.ready')}
        detail={t('common:modelLoad.loadedIntoMemory')}
      />
    )
  }

  const progress = shown.progress ?? { kind: 'preparing' as const }
  return (
    <SnackbarCard
      testId="model-load-snackbar"
      face="loading"
      dismissLabel={t('common:modelLoad.dismiss')}
      onClose={onClose}
      icon={
        <IconLoader2
          size={16}
          className="shrink-0 animate-spin text-muted-foreground"
        />
      }
      title={t('common:modelLoad.starting')}
      detail={t(`common:modelLoad.stage.${modelLoadStageKey(progress)}`)}
      stage={progress.kind}
      action={
        <Button
          variant="ghost"
          size="sm"
          className="h-auto min-h-8 w-28 shrink-0 px-2 py-1 leading-snug whitespace-normal [overflow-wrap:anywhere] text-muted-foreground"
          disabled={shown.cancelling}
          onClick={() => {
            void cancelModelLoad(serviceHub)
          }}
        >
          {shown.cancelling
            ? t('common:modelLoad.cancelling')
            : t('common:modelLoad.cancel')}
        </Button>
      }
    />
  )
}

function SnackbarCard(props: {
  testId: string
  face: 'loading' | 'loaded'
  icon: ReactNode
  title: string
  detail?: string
  stage?: string
  action?: ReactNode
  dismissLabel: string
  onClose: () => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={props.testId}
      data-face={props.face}
      data-stage={props.stage}
      className="relative flex w-full max-w-full items-center gap-3 rounded-xl border bg-background py-3 pr-9 pl-4 shadow-md"
    >
      {props.icon}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-snug [overflow-wrap:anywhere] text-foreground">
          {props.title}
        </div>
        {props.detail && (
          <div className="mt-0.5 text-xs leading-snug [overflow-wrap:anywhere] text-muted-foreground">
            {props.detail}
          </div>
        )}
      </div>
      {props.action}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={props.dismissLabel}
        onClick={props.onClose}
        className="absolute top-1.5 right-1.5 text-muted-foreground"
      >
        <IconX size={14} />
      </Button>
    </div>
  )
}

export default ModelLoadSnackbar
