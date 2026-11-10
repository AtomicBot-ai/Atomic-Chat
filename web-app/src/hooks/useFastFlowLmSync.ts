import { isFastFlowLmInstallFinished } from '@/lib/fastflowlm/install-state'
import { invoke } from '@tauri-apps/api/core'
import { useEffect } from 'react'
import { EngineManager } from '@janhq/core'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { restoreInterruptedDownloads } from '@/lib/interrupted-downloads'
import {
  fastFlowLmDownloadId,
  fastFlowLmInstallJobs,
  resumeFastFlowLmDownload,
} from '@/services/fastflowlm/install'

/** Recover the original native journal; a downloaded marker alone cannot release maintenance. */
export function useFastFlowLmSync() {
  const serviceHub = useServiceHub()
  const registered = useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === 'fastflowlm')
  )
  useEffect(() => {
    if (!registered) return
    let alive = true
    let pending: Promise<void> | undefined
    const refreshProvider = async () => {
      const engine = EngineManager.instance().engines.get('fastflowlm') as
        | { invalidateModelList?: () => void }
        | undefined
      engine?.invalidateModelList?.()
      const providers = await serviceHub.providers().getProviders()
      if (alive) useModelProvider.getState().setProviders(providers)
    }
    const recover = () => {
      if (pending) return pending
      pending = (async () => {
        const errors = await invoke<string[]>(
          'atomic_fastflowlm_recover_mutations'
        )
        errors.forEach((error) => console.warn('[atomic-fastflowlm]', error))
        const jobs = await fastFlowLmInstallJobs()
        for (const job of jobs) {
          if (!alive || isFastFlowLmInstallFinished(job)) continue
          const id = fastFlowLmDownloadId(job.model_id)
          useDownloadStore.getState().setDownloadOrigin(id, job.plan.name)
          if (job.running) {
            useDownloadStore.getState().addLocalDownloadingModel(id)
            continue
          }
          if (job.state !== 'downloading') {
            await resumeFastFlowLmDownload(
              id,
              useGeneralSetting.getState().huggingfaceToken
            )
            await refreshProvider()
          } else {
            restoreInterruptedDownloads([
              {
                id,
                name: job.plan.name,
                current: 0,
                total: job.plan.total_bytes,
                progress: 0,
              },
            ])
          }
        }
      })()
        .catch((e) =>
          console.warn('[atomic-fastflowlm] recovery needs attention:', e)
        )
        .finally(() => {
          pending = undefined
        })
      return pending
    }
    const listeners = Promise.all([
      serviceHub.events().listen('atomic-core://snapshot', () => {
        void recover()
      }),
      serviceHub.events().listen('atomic-fastflowlm-models-changed', () => {
        void refreshProvider().catch(console.warn)
      }),
    ]).catch((error) => {
      console.warn(error)
      return []
    })
    void recover()
    return () => {
      alive = false
      void listeners
        .then((stops) => stops.forEach((stop) => stop()))
        .catch(console.warn)
    }
  }, [serviceHub, registered])
}
