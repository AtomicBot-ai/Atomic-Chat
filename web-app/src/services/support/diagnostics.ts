/**
 * Diagnostics attached to support-chat messages, so the team can answer
 * without asking what the user runs. Zero-PII in the same sense as the
 * analytics super-properties: no machine name, no paths, no GPU UUIDs. The
 * analytics id goes along only while the user allows analytics.
 *
 * Every field is optional and nothing here throws: a diagnostics failure must
 * never stop a message from being sent.
 */

import { getServiceHub } from '@/hooks/useServiceHub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useProductAnalytic } from '@/hooks/useAnalytic'
import i18n from '@/i18n/setup'
import {
  readDeviceBackendPref,
  readHardwareInfo,
  readInstallerType,
  withTimeout,
} from '@/lib/hardware-summary'
import type { ServiceHub } from '@/services'
import type { SupportGpu, SupportMeta } from '@/services/support/client'

/** MiB → GiB with one decimal, or undefined for a missing or zero value. */
const toGb = (mib: number | undefined | null): number | undefined =>
  typeof mib === 'number' && Number.isFinite(mib) && mib > 0
    ? Math.round((mib / 1024) * 10) / 10
    : undefined

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** What does not change while the app runs: read once per session. */
type MachineMeta = Pick<
  SupportMeta,
  | 'core_version'
  | 'installer_type'
  | 'os_name'
  | 'arch'
  | 'cpu'
  | 'ram_gb'
  | 'gpus'
>

let machineMeta: Promise<MachineMeta> | null = null

/** Test seam: read the machine again on the next collection. */
export const resetSupportDiagnosticsCache = (): void => {
  machineMeta = null
}

const readMachineMeta = async (
  serviceHub: ServiceHub
): Promise<MachineMeta> => {
  const meta: MachineMeta = {}
  const [coreVersion, installerType, hw] = await Promise.all([
    withTimeout(serviceHub.app().getCoreVersion(), 1500).catch(() => undefined),
    readInstallerType(serviceHub),
    readHardwareInfo(serviceHub),
  ])
  if (nonEmpty(coreVersion)) meta.core_version = nonEmpty(coreVersion)
  if (installerType) meta.installer_type = installerType
  if (hw) {
    const osName = nonEmpty(hw.os_name) ?? nonEmpty(hw.os_type)
    if (osName) meta.os_name = osName
    const arch = nonEmpty(hw.cpu?.arch)
    if (arch) meta.arch = arch
    const cpu = nonEmpty(hw.cpu?.name)
    if (cpu) meta.cpu = cpu
    const ram = toGb(hw.total_memory)
    if (ram !== undefined) meta.ram_gb = ram
    const gpus = (hw.gpus ?? []).map((gpu): SupportGpu => {
      const entry: SupportGpu = {}
      const vendor = nonEmpty(gpu.vendor)
      if (vendor) entry.vendor = vendor
      const name = nonEmpty(gpu.name)
      if (name) entry.name = name
      const vram = toGb(gpu.total_memory)
      if (vram !== undefined) entry.vram_gb = vram
      return entry
    })
    if (gpus.length > 0) meta.gpus = gpus
  }
  return meta
}

const machineMetaFor = (serviceHub: ServiceHub): Promise<MachineMeta> => {
  if (!machineMeta) {
    const pending = readMachineMeta(serviceHub)
      .then((meta) => {
        // A read that came back without hardware is retried next time.
        if (!meta.os_name && !meta.cpu) machineMeta = null
        return meta
      })
      .catch(() => {
        machineMeta = null
        return {}
      })
    machineMeta = pending
  }
  return machineMeta
}

const safely = <T>(read: () => T): T | undefined => {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** Collects the diagnostics. Never throws; missing facts are left out. */
export async function collectSupportMeta(): Promise<SupportMeta> {
  const meta: SupportMeta = {}
  try {
    meta.app_version = nonEmpty(safely(() => VERSION))

    const backend = safely(readDeviceBackendPref)
    if (backend) meta.backend = backend

    const selection = safely(() => useModelProvider.getState())
    const provider = nonEmpty(selection?.selectedProvider)
    if (provider) meta.provider = provider
    const model = nonEmpty(selection?.selectedModel?.id)
    if (model) meta.model = model

    const locale = nonEmpty(safely(() => i18n.language))
    if (locale) meta.locale = locale
    const timezone = nonEmpty(
      safely(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
    )
    if (timezone) meta.timezone = timezone

    // Not there yet very early in a launch: send what is known without it.
    const serviceHub = safely(getServiceHub)
    if (serviceHub) {
      Object.assign(meta, await machineMetaFor(serviceHub))

      if (safely(() => useProductAnalytic.getState().productAnalytic)) {
        const distinctId = await withTimeout(
          serviceHub.analytic().getAppDistinctId(),
          1000
        ).catch(() => undefined)
        if (nonEmpty(distinctId))
          meta.posthog_distinct_id = nonEmpty(distinctId)
      }
    }
  } catch (error) {
    console.warn('[support] diagnostics incomplete:', error)
  }
  for (const key of Object.keys(meta) as (keyof SupportMeta)[]) {
    if (meta[key] === undefined) delete meta[key]
  }
  return meta
}

/** Same object → same string, whatever order its keys were set in. */
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** A short fingerprint of the diagnostics (FNV-1a), to send them only when they change. */
export function hashSupportMeta(meta: SupportMeta): string {
  const text = stableStringify(meta)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
