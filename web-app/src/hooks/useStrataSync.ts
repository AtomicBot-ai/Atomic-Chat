import { invoke } from '@tauri-apps/api/core'
import { useEffect } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { refreshAppManagedProviders } from '@/lib/provider-visibility'
import { restoreInterruptedDownloads } from '@/lib/interrupted-downloads'
import { listStrataPreparations } from '@/services/strata/core'
import {
  isStrataRunning,
  listStrataJobs,
  resumeStrata,
  strataTaskId,
} from '@/services/strata/install'

export function useStrataSync() {
  const services = useServiceHub()
  useEffect(() => {
    if (!IS_TAURI || IS_IOS || IS_ANDROID) return
    let active = true
    let recovering = false
    async function refreshModels() {
      try {
        const providers = await services.providers().getProviders()
        if (active) useModelProvider.getState().setProviders(providers)
      } catch (error) {
        console.warn(error)
      }
    }
    async function recover() {
      if (recovering) return
      recovering = true
      try {
        const jobs = await listStrataJobs()
        if (!active || !jobs.length) return
        const operations = await listStrataPreparations()
        for (const job of jobs) {
          if (!active) break
          if (job.removing && !job.running) {
            void invoke('atomic_strata_remove_model', {
              modelId: job.model_id,
            }).catch(console.warn)
            continue
          }
          if (job.state === 'ready') continue
          const id = strataTaskId(job.model_id)
          if (job.running || isStrataRunning(id)) continue
          const descriptor = job.plan.descriptor
          useDownloadStore.getState().setDownloadOrigin(id, descriptor.name)
          const operation = operations.find(
            (item) => item.request_id === job.plan.request_id
          )
          if (
            job.state === 'publishing' ||
            (job.state === 'files-ready' &&
              (!operation ||
                ['queued', 'preparing', 'verifying', 'ready'].includes(
                  operation.state
                )))
          ) {
            void resumeStrata(
              id,
              useGeneralSetting.getState().huggingfaceToken
            ).catch(console.warn)
          } else {
            restoreInterruptedDownloads([
              {
                id,
                name: descriptor.name,
                current: 0,
                total: descriptor.requirements.download_bytes,
                progress: 0,
              },
            ])
          }
        }
      } catch (error) {
        console.warn('Could not restore Strata downloads:', error)
      } finally {
        recovering = false
      }
    }
    const listeners = [
      services
        .events()
        .listen<{
          engine?: string
        }>('atomic-core://engine:changed', (event) => {
          if (event.payload?.engine !== 'strata') return
          void refreshAppManagedProviders(() =>
            services.providers().getProviders()
          )
            .then(refreshModels)
            .catch(console.warn)
        }),
      services.events().listen('atomic-core://snapshot', () => {
        void recover()
      }),
      services.events().listen('atomic-strata-models-changed', () => {
        void refreshModels()
      }),
    ]
    void recover()
    return () => {
      active = false
      for (const stop of listeners)
        void stop.then((dispose) => dispose()).catch(console.warn)
    }
  }, [services])
}
