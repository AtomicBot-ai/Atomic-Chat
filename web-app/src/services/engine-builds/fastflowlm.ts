import { create } from 'zustand'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { engineBuildCatalog, engineBuildProxy } from './core'
import { engineBuildTaskId, installEngineBuildWithProgress } from './install'
import type { EngineBuildInstallResult } from './types'

/** The panel and onboarding share one core-owned engine installation. */
export const useFastFlowLmEngineInstallStore = create<{
  installing: boolean
  progress: { transferred: number; total: number } | null
}>()(() => ({ installing: false, progress: null }))

let running: Promise<EngineBuildInstallResult> | null = null
async function install(): Promise<EngineBuildInstallResult> {
  const proxy = engineBuildProxy()
  const catalog = await engineBuildCatalog('fastflowlm', proxy ? { proxy } : {})
  if (!catalog.manifest && catalog.manifest_error)
    throw { code: 'UPSTREAM_ERROR', message: catalog.manifest_error }
  if (!catalog.host_backend_id)
    throw {
      code: 'UNSUPPORTED_BACKEND',
      message:
        catalog.host_reason ??
        'No verified FastFlowLM engine build is available for this computer.',
    }
  const result = await installEngineBuildWithProgress('fastflowlm', {
    taskId: engineBuildTaskId('fastflowlm', catalog.manifest?.tag ?? 'unknown'),
    onProgress: (progress) =>
      useFastFlowLmEngineInstallStore.setState({ progress }),
  })
  await useEngineVersionsStore.getState().refresh()
  return result
}

export function installFastFlowLmEngine(): Promise<EngineBuildInstallResult> {
  if (running) return running
  useFastFlowLmEngineInstallStore.setState({ installing: true, progress: null })
  const pending = install().finally(() => {
    running = null
    useFastFlowLmEngineInstallStore.setState({
      installing: false,
      progress: null,
    })
  })
  running = pending
  return pending
}
