import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { describeFinishedDownload } from '@/lib/downloadNotification'
import {
  currentSetupTask,
  isFinalSetup,
  isRunningSetup,
  latestSetupFor,
  parseHubFileUrl,
  setupBytes,
  setupsUnderWay,
  type HubFile,
  type TaskProgress,
} from '@/lib/model-setup'
import { notifyWhenAway } from '@/lib/notifications'
import type {
  CompatibilityVerdict,
  ModelSetup,
} from '@/services/model-setup/types'
import { useModelSetupStore } from '@/stores/model-setup-store'

/** Verdict requests in flight, so two rows of one file ask the core once. */
const asking = new Set<string>()

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * Says how a setup ended, as the download panel says it for an ordinary
 * download: the sheet may be closed, and then nothing else would.
 */
function announceSetupEnd(setup: ModelSetup, t: Translate): void {
  const item = setup.plan.model_id
  switch (setup.stage) {
    case 'ready': {
      const notification = describeFinishedDownload(item, 'Model', null, t)
      if (notification) notifyWhenAway(notification.title, notification.body)
      toast.success(t('common:toast.downloadComplete.title'), {
        id: 'download-complete',
        description: t('common:toast.downloadComplete.description', { item }),
      })
      return
    }
    case 'failed':
      toast.error(t('common:toast.downloadFailed.title'), {
        id: 'download-failed',
        description: setup.error
          ? t('hub:prismSetupFailed', { error: setup.error.message })
          : t('common:toast.downloadFailed.description', { item }),
      })
      return
    case 'cancelled':
      toast.info(t('common:toast.downloadCancelled.title'), {
        id: 'cancel-download',
        description: t('common:toast.downloadCancelled.description'),
      })
      return
  }
}

/**
 * Keeps the store in step with the core's setups: the list on attach and on
 * every new core generation, then each change as it is written. A setup that
 * reaches `ready` registered a model, so the providers are read again — the
 * same refresh an ordinary download ends with. A setup this window saw under
 * way that ends — ready, failed or cancelled — is announced with the toasts an
 * ordinary download ends with. Mount once, at the app root.
 */
export function useModelSetupSync(): void {
  const serviceHub = useServiceHub()
  const { t } = useTranslation()

  useEffect(
    () =>
      useModelSetupStore.subscribe((state, previous) => {
        if (state.setups === previous.setups) return
        for (const setup of Object.values(state.setups)) {
          const before = previous.setups[setup.setup_id]
          if (before && !isFinalSetup(before) && isFinalSetup(setup))
            announceSetupEnd(setup, t)
        }
      }),
    [t]
  )

  useEffect(() => {
    const service = serviceHub.modelSetup()
    if (!service.isSupported()) return
    const store = useModelSetupStore.getState()

    const relist = () => {
      service
        .list()
        .then((setups) => useModelSetupStore.getState().replaceAll(setups))
        .catch((error) =>
          console.debug('[model-setup] could not list setups:', error)
        )
    }

    const refreshProviders = async (setup: ModelSetup) => {
      const { clearDeletedModel, setProviders } = useModelProvider.getState()
      clearDeletedModel(setup.plan.model_id)
      try {
        setProviders(await serviceHub.providers().getProviders())
      } catch (error) {
        console.error('[model-setup] could not refresh providers:', error)
      }
    }

    const unsubscribe = service.subscribe((event) => {
      if (event.type === 'changed' && event.setup.stage === 'ready') {
        const known = useModelSetupStore.getState().setups[event.setup.setup_id]
        if (known?.stage !== 'ready') void refreshProviders(event.setup)
      }
      useModelSetupStore.getState().apply(event)
      if (event.type === 'reset') relist()
    })
    store.apply({ type: 'reset' })
    relist()
    return unsubscribe
  }, [serviceHub])
}

/**
 * The core's verdict on one Hub file, asked lazily from the conf rules alone
 * (no remote header read, so no download per row). `undefined` while unknown
 * or where there is no core; `null` when the core could not say.
 */
export function useCompatibilityVerdict(
  url: string | undefined
): CompatibilityVerdict | null | undefined {
  const serviceHub = useServiceHub()
  const verdict = useModelSetupStore((state) =>
    url ? state.verdicts[url] : undefined
  )
  const known = useModelSetupStore((state) =>
    url ? Object.hasOwn(state.verdicts, url) : false
  )

  useEffect(() => {
    if (!url || known || asking.has(url)) return
    const service = serviceHub.modelSetup()
    const file = parseHubFileUrl(url)
    if (!service.isSupported() || !file) return
    asking.add(url)
    service
      .checkCompatibility({ ...file, provider: 'llamacpp-upstream' })
      .then((answer) => useModelSetupStore.getState().setVerdict(url, answer))
      .catch(() => useModelSetupStore.getState().setVerdict(url, null))
      .finally(() => asking.delete(url))
  }, [url, known, serviceHub])

  return verdict
}

/** The newest setup of one Hub file, if any was ever started. */
export function useHubFileSetup(file: HubFile | null): ModelSetup | undefined {
  const setups = useModelSetupStore((state) => state.setups)
  return useMemo(
    () => (file ? latestSetupFor(Object.values(setups), file) : undefined),
    [setups, file]
  )
}

export type SetupDownload = {
  setup: ModelSetup
  bytes: TaskProgress
  /** Smoothed bytes/second of the download running now; 0 between them. */
  bytesPerSecond: number
}

/** The setups the download panel lists, with how far each has come and how fast. */
export function useModelSetupDownloads(): SetupDownload[] {
  const setups = useModelSetupStore((state) => state.setups)
  const progress = useModelSetupStore((state) => state.progress)
  const speeds = useModelSetupStore((state) => state.speeds)
  return useMemo(
    () =>
      setupsUnderWay(Object.values(setups)).map((setup) => {
        const task = isRunningSetup(setup) ? currentSetupTask(setup) : undefined
        return {
          setup,
          bytes: setupBytes(setup, progress),
          bytesPerSecond: (task && speeds[task]?.bytesPerSecond) || 0,
        }
      }),
    [setups, progress, speeds]
  )
}

/** Bytes done over bytes to do across a setup's downloads. */
export function useModelSetupBytes(
  setup: ModelSetup | undefined
): TaskProgress {
  const progress = useModelSetupStore((state) => state.progress)
  return useMemo(
    () => (setup ? setupBytes(setup, progress) : { transferred: 0, total: 0 }),
    [setup, progress]
  )
}
