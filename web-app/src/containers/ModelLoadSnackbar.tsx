/**
 * Model-load feedback in the app's normal Sonner notification column.
 *
 * Loading, ready and failure used to be three different visual systems. The
 * loading/ready pair now uses ordinary `toast.loading` / `toast.success` with
 * one stable id, so it inherits exactly the same width, offset, padding and
 * icon geometry as every other snackbar.
 */
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import { useInferenceStatus } from '@/hooks/useInferenceStatus'
import { useServiceHub } from '@/hooks/useServiceHub'
import i18n from '@/i18n/setup'
import type { InferenceStatus } from '@/lib/inference-status'
import { cancelModelLoad } from '@/utils/switchModel'

/** How long "Model ready" stays up before Sonner clears it. */
export const LOADED_SNACKBAR_MS = 3000

const isLoading = (status: InferenceStatus) =>
  status.phase === 'starting' || status.phase === 'restarting'

let toastSeq = 0

export function ModelLoadSnackbar() {
  const status = useInferenceStatus()
  const serviceHub = useServiceHub()
  const loading = isLoading(status)
  const { phase, modelId, cancelling } = status
  const latestStatus = useRef(status)
  latestStatus.current = status

  const shownRef = useRef<{
    id: string
    face: 'loading' | 'loaded'
    cancelling: boolean
  } | null>(null)
  const closedDuringLoadRef = useRef(false)

  useEffect(() => {
    const hide = () => {
      if (shownRef.current) toast.dismiss(shownRef.current.id)
      shownRef.current = null
    }

    const onDismiss = () => {
      if (isLoading(latestStatus.current)) closedDuringLoadRef.current = true
      shownRef.current = null
    }

    if (loading) {
      if (closedDuringLoadRef.current) return
      const cancelInProgress = Boolean(cancelling)
      if (
        shownRef.current?.face === 'loading' &&
        shownRef.current.cancelling === cancelInProgress
      ) {
        return
      }

      const id =
        shownRef.current?.face === 'loading'
          ? shownRef.current.id
          : `model-load-${++toastSeq}`
      toast.loading(i18n.t('common:modelLoad.starting'), {
        id,
        className: 'model-load-snackbar',
        classNames: {
          icon:
            'size-4 shrink-0 overflow-hidden [&_.sonner-loading-wrapper]:size-4 [&_.sonner-loading-wrapper]:overflow-hidden [&_.sonner-spinner]:size-4',
          content: 'min-w-0',
          actionButton:
            'h-auto! border-0! bg-transparent! p-0! font-normal! text-muted-foreground! shadow-none! hover:bg-transparent! hover:text-foreground! hover:underline underline-offset-4',
        },
        description: i18n.t('common:modelLoad.loadingIntoMemory'),
        duration: Infinity,
        closeButton: true,
        onDismiss,
        action: cancelInProgress
          ? null
          : {
              label: i18n.t('common:modelLoad.cancel'),
              onClick: () => void cancelModelLoad(serviceHub),
            },
      })
      shownRef.current = {
        id,
        face: 'loading',
        cancelling: cancelInProgress,
      }
      return
    }

    closedDuringLoadRef.current = false

    if (shownRef.current?.face === 'loading' && phase === 'ready') {
      const id = shownRef.current.id
      toast.success(i18n.t('common:modelLoad.ready'), {
        id,
        className: 'model-load-snackbar',
        classNames: {
          icon: 'size-4 shrink-0 overflow-hidden [&_svg]:size-4',
          content: 'min-w-0',
        },
        description: i18n.t('common:modelLoad.loadedIntoMemory'),
        duration: LOADED_SNACKBAR_MS,
        closeButton: true,
        action: null,
        onDismiss,
        onAutoClose: () => {
          if (shownRef.current?.id === id) shownRef.current = null
        },
      })
      shownRef.current = { id, face: 'loaded', cancelling: false }
      return
    }

    if (shownRef.current?.face !== 'loaded' || phase !== 'ready') hide()
  }, [loading, phase, modelId, cancelling, serviceHub])

  useEffect(
    () => () => {
      if (shownRef.current) toast.dismiss(shownRef.current.id)
    },
    []
  )

  return null
}

export default ModelLoadSnackbar
