import {
  engineBuildCatalog,
  engineBuildProxy,
} from '@/services/engine-builds/core'
import {
  engineBuildTaskId,
  installEngineBuildWithProgress,
} from '@/services/engine-builds/install'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

let pending: Promise<void> | undefined

export function installStrataEngine(): Promise<void> {
  pending ??= (async () => {
    const proxy = engineBuildProxy()
    const catalog = await engineBuildCatalog('strata', proxy ? { proxy } : {})
    if (!catalog.host_backend_id) {
      throw new Error(
        catalog.host_reason ??
          catalog.manifest_error ??
          'No Strata engine build is available.'
      )
    }
    await installEngineBuildWithProgress('strata', {
      taskId: engineBuildTaskId('strata', catalog.manifest?.tag ?? 'current'),
    })
    await useEngineVersionsStore.getState().refresh()
  })().finally(() => {
    pending = undefined
  })
  return pending
}
