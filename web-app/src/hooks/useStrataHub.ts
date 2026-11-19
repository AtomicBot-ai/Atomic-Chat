import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_STRATA_QWEN38,
  fetchStrataCatalog,
  groupStrataCatalogRows,
} from '@/services/strata/catalog'
import { checkStrataModel } from '@/services/strata/core'
import { listStrataJobs } from '@/services/strata/install'
import { getDiskSpaceInfo } from '@/services/models/downloadPreflight'
import type { CatalogModel } from '@/services/models/types'
import { useModelProvider } from '@/hooks/useModelProvider'
import { engineBuildCatalog } from '@/services/engine-builds/core'

const MAC_METAL_VARIANT = 'macos-arm64-metal'

export function useStrataHub(enabled: boolean, checkMacDisk: boolean) {
  const [models, setModels] = useState<CatalogModel[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [hostBackendId, setHostBackendId] = useState<string>()
  const visibleModels = useMemo(
    () =>
      groupStrataCatalogRows(models, IS_MACOS ? MAC_METAL_VARIANT : hostBackendId),
    [models, hostBackendId]
  )
  const recommended = IS_MACOS
    ? visibleModels.find(
        (model) => model.strata?.variant_id === DEFAULT_STRATA_QWEN38
      )
    : undefined
  const installedModels = useModelProvider((state) =>
    state.providers.find((provider) => provider.provider === 'strata')?.models
  )
  const [diskBlocked, setDiskBlocked] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (!enabled) return
    let active = true
    setLoading(true)
    setFailed(false)
    void fetchStrataCatalog().then(
      (rows) => {
        if (!active) return
        setModels(rows)
        setLoading(false)
      },
      () => {
        if (!active) return
        setFailed(true)
        setLoading(false)
      }
    )
    return () => {
      active = false
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || IS_MACOS) return
    let active = true
    void engineBuildCatalog('strata').then(
      (build) => {
        if (active) setHostBackendId(build.active?.backend_id ?? build.host_backend_id ?? undefined)
      },
      () => {
        if (active) setHostBackendId(undefined)
      }
    )
    return () => {
      active = false
    }
  }, [enabled])

  useEffect(() => {
    if (!checkMacDisk || visibleModels.length === 0) return
    let sequence = 0
    const pending = visibleModels
      .flatMap(({ strata, strataVariants }) => strataVariants ?? (strata ? [strata] : []))
      .filter((descriptor) => !installedModels?.some((model) => model.id === descriptor.variant_id))
    const refresh = async () => {
      const current = ++sequence
      const results = await Promise.all(
        pending.map(async (descriptor) => ({
          descriptor,
          verdict: (await checkStrataModel({ descriptor }).catch(() => null))?.verdict,
        }))
      )
      if (current !== sequence) return
      const blocked = new Set(
        results
          .filter(({ verdict }) => verdict === 'insufficient-disk')
          .map(({ descriptor }) => descriptor.variant_id)
      )
      const needsPreflight = results.filter(
        ({ verdict }) =>
          verdict === 'engine-not-installed' || verdict === 'requires-newer-engine'
      )
      if (needsPreflight.length) {
        // Core estimates preparation only with a compatible engine. Before that,
        // a fresh model's source size is a lower bound on what the volume must hold.
        const [space, jobs] = await Promise.all([
          getDiskSpaceInfo('strata'),
          listStrataJobs().catch(() => null),
        ])
        if (space && jobs) {
          for (const { descriptor } of needsPreflight) {
            if (
              descriptor.requirements.download_bytes > space.free_bytes &&
              !jobs.some((job) => job.model_id === descriptor.variant_id)
            ) {
              blocked.add(descriptor.variant_id)
            }
          }
        }
      }
      if (current === sequence) setDiskBlocked(blocked)
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      sequence++
      window.removeEventListener('focus', refresh)
    }
  }, [checkMacDisk, installedModels, visibleModels])

  return { models: visibleModels, recommended, diskBlocked, loading, failed }
}
