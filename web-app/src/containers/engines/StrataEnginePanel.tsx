import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { DropdownControl } from '@/containers/dynamicControllerSetting/DropdownControl'
import { InstalledEngineBuilds } from '@/containers/engines/InstalledEngineBuilds'
import { useHardware } from '@/hooks/useHardware'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/utils'
import {
  engineUpdateTaskId,
  updateEngineWithProgress,
} from '@/services/engines/update'
import { installStrataEngine } from '@/services/strata/engine'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

export function StrataGpuSetting({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const hardware = useHardware((state) => state.hardwareData)
  const hardwareReady = useHardware((state) => state.hardwareReady)
  const setHardwareData = useHardware((state) => state.setHardwareData)
  const variant = useEngineVersionsStore((state) =>
    state.engines.strata?.active?.variant ?? state.engines.strata?.latest?.variant
  )
  useEffect(() => {
    if (hardwareReady) return
    let active = true
    void serviceHub.hardware().getHardwareInfo().then((info) => {
      if (active && info) setHardwareData(info)
    }).catch(() => undefined)
    return () => { active = false }
  }, [hardwareReady, serviceHub, setHardwareData])

  const options = [{ value: '', name: t('hub:strata.gpuAuto') }]
  if (variant === 'macos-arm64-metal' || (hardware.os_type === 'macos' && hardware.cpu.arch === 'aarch64')) {
    options.push({ value: 'apple:0', name: hardware.cpu.name || 'Apple GPU' })
  } else {
    const vendor = variant?.includes('cuda')
      ? 'nvidia'
      : variant?.includes('sycl')
        ? 'intel'
        : variant
          ? 'amd'
          : undefined
    const gpuIds = new Set<string>()
    for (const gpu of hardware.gpus) {
      const detectedVendor = gpu.vendor.toLowerCase()
      if (
        !gpu.uuid ||
        (vendor && vendor !== detectedVendor) ||
        !['nvidia', 'amd', 'intel'].includes(detectedVendor)
      ) continue
      // The hardware response omits GPU- from NVIDIA UUIDs. Strata uses the
      // full UUID so the choice survives changes to driver ordinals.
      const id = detectedVendor === 'nvidia' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(gpu.uuid)
        ? `GPU-${gpu.uuid}`
        : gpu.uuid
      if (gpuIds.has(id)) continue
      gpuIds.add(id)
      options.push({ value: id, name: gpu.name || id })
    }
  }
  const missing = value !== '' && !options.some((option) => option.value === value)
  if (missing) options.push({ value, name: value })

  return (
    <CardItem
      title="GPU"
      description={t(missing ? 'hub:strata.gpuMissing' : 'hub:strata.gpuDescription')}
      classNameWrapperAction="w-80 max-w-[50%]"
      actions={
        <DropdownControl
          value={value}
          options={options}
          onChange={(id) => onChange(String(id))}
        />
      }
    />
  )
}

export function StrataEnginePanel() {
  const { t } = useTranslation()
  const versions = useEngineVersionsStore((state) => state.engines.strata)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const update = versions?.update.needed ? versions.update.target : null
  const latest = versions?.active ? update : versions?.latest

  async function apply() {
    setBusy(true)
    setError(undefined)
    try {
      if (update) {
        await updateEngineWithProgress('strata', {
          taskId: engineUpdateTaskId('strata', update.version),
          backend: `${update.version}/${update.variant}`,
        })
      } else {
        await installStrataEngine()
      }
    } catch (error) {
      const refusal = error as { code?: string; message?: string }
      if (refusal?.code !== 'CANCELLED')
        setError(refusal?.message ?? String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardItem
        title={t('hub:strata.engineTitle')}
        description={
          latest?.download_bytes
            ? formatBytes(latest.download_bytes)
            : versions?.source_error
        }
        actions={
          latest && (
            <Button size="sm" disabled={busy} onClick={() => void apply()}>
              {t(
                update ? 'hub:strata.updateEngine' : 'hub:strata.installEngine'
              )}
            </Button>
          )
        }
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <InstalledEngineBuilds engine="strata" />
    </Card>
  )
}
