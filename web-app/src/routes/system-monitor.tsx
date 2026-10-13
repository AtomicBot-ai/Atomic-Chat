/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useHardware } from '@/hooks/useHardware'
import { Progress } from '@/components/ui/progress'
import { route } from '@/constants/routes'
import { formatMegaBytes } from '@/lib/utils'
import { IconDeviceDesktopAnalytics } from '@tabler/icons-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toNumber } from '@/utils/number'
import { useLlamacppDevices } from '@/hooks/useLlamacppDevices'
import { useServiceHub } from '@/hooks/useServiceHub'
import { DriverOutdatedBanner } from '@/containers/DriverOutdatedBanner'
import { buildFallbackDevices } from '@/lib/gpuFallback'
import PerformanceBenchmarkPanel from '@/containers/PerformanceBenchmarkPanel'

export const Route = createFileRoute(route.systemMonitor as any)({
  component: SystemMonitorContent,
})

function SystemMonitorContent() {
  const { t } = useTranslation()
  const { hardwareData, systemUsage, updateSystemUsage } = useHardware()
  const serviceHub = useServiceHub()

  const { devices: llamacppDevices, fetchDevices } = useLlamacppDevices()

  useEffect(() => {
    // Fetch llamacpp devices
    fetchDevices()
  }, [updateSystemUsage, fetchDevices])

  // Poll system usage every 5 seconds
  useEffect(() => {
    const intervalId = setInterval(() => {
      serviceHub
        .hardware()
        .getSystemUsage()
        .then((data) => {
          if (data) {
            updateSystemUsage(data)
          }
        })
        .catch((error) => {
          console.error('Failed to get system usage:', error)
        })
    }, 5000)

    return () => clearInterval(intervalId)
  }, [updateSystemUsage, serviceHub])

  // Calculate RAM usage percentage
  const ramUsagePercentage =
    toNumber(systemUsage.used_memory / hardwareData.total_memory) * 100

  const liveGpuUsage = systemUsage.gpus.filter((gpu) => gpu.available === true)
  const aggregateGpu = liveGpuUsage.reduce(
    (acc, gpu) => ({
      used: acc.used + gpu.used_memory,
      total: acc.total + gpu.total_memory,
    }),
    { used: 0, total: 0 }
  )

  return (
    <div className="flex flex-col h-full bg-background overflow-y-auto p-6">
      <div className="flex items-center mb-4 gap-2">
        <IconDeviceDesktopAnalytics className="text-muted-foreground/80 size-6" />
        <h1 className="text-xl font-bold text-muted-foreground">
          {t('system-monitor:title')}
        </h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* CPU Usage Card */}
        <div className="bg-secondary/50 rounded-lg p-6 shadow-sm">
          <h2 className="text-base font-semibold mb-4">
            {t('system-monitor:cpuUsage')}
          </h2>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">
                {t('system-monitor:model')}
              </span>
              <span className="text-foreground">{hardwareData.cpu.name}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">
                {t('system-monitor:cores')}
              </span>
              <span className="text-foreground">
                {hardwareData.cpu.core_count}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">
                {t('system-monitor:architecture')}
              </span>
              <span className="text-foreground">{hardwareData.cpu.arch}</span>
            </div>
            <div className="mt-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-muted-foreground">
                  {t('system-monitor:currentUsage')}
                </span>
                <span className="text-foreground font-bold">
                  {systemUsage.cpu.toFixed(2)}%
                </span>
              </div>
              <Progress value={systemUsage.cpu} className="h-3 w-full" />
            </div>
          </div>
        </div>

        {/* RAM Usage Card */}
        <div className="bg-secondary/50 rounded-lg p-6 shadow-sm">
          <h2 className="text-base font-semibold mb-4">
            {t('system-monitor:memoryUsage')}
          </h2>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">
                {t('system-monitor:totalRam')}
              </span>
              <span className="text-foreground">
                {formatMegaBytes(hardwareData.total_memory)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">
                {t('system-monitor:availableRam')}
              </span>
              <span className="text-foreground">
                {formatMegaBytes(
                  hardwareData.total_memory - systemUsage.used_memory
                )}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">
                {t('system-monitor:usedRam')}
              </span>
              <span className="text-foreground">
                {formatMegaBytes(systemUsage.used_memory)}
              </span>
            </div>
            <div className="mt-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-muted-foreground">
                  {t('system-monitor:currentUsage')}
                </span>
                <span className="text-foreground font-bold">
                  {ramUsagePercentage.toFixed(2)}%
                </span>
              </div>
              <Progress value={ramUsagePercentage} className="h-3 w-full" />
            </div>
          </div>
        </div>

        {/* GPU Usage Card */}
        {!IS_MACOS && (
          <div className="bg-secondary/50 rounded-lg p-6 shadow-sm">
            <h2 className="text-base font-semibold mb-4">
              {t('system-monitor:activeGpus')}
            </h2>
            {hardwareData.gpus.length > 0 && llamacppDevices.length === 0 && (
              <DriverOutdatedBanner gpus={hardwareData.gpus} className="mb-4" />
            )}
            <div className="flex flex-col gap-2">
              {llamacppDevices.length > 0 ? (
                llamacppDevices.map((device) => (
                  <div key={device.id} className="flex flex-col gap-1">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">
                        {device.name}
                      </span>
                      <span
                        className={`text-sm px-2 py-1 rounded-md ${
                          device.activated
                            ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                            : 'hidden'
                        }`}
                      >
                        {device.activated
                          ? t('system-monitor:active')
                          : 'Inactive'}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">VRAM:</span>
                      <span className="text-foreground">
                        {formatMegaBytes(device.mem)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">Free:</span>
                      <span className="text-foreground">
                        {formatMegaBytes(device.free)}
                      </span>
                    </div>
                  </div>
                ))
              ) : hardwareData.gpus.length > 0 ? (
                <>
                  {buildFallbackDevices(hardwareData.gpus).map((device) => (
                    <div key={device.id} className="flex flex-col gap-1">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">
                          {device.name}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">VRAM:</span>
                        <span className="text-foreground">
                          {formatMegaBytes(device.totalMemoryMiB)}
                        </span>
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground/80 mt-2">
                    {t('system-monitor:liveStatsUnavailable')}
                  </p>
                </>
              ) : (
                <div className="text-muted-foreground text-center py-4">
                  {t('system-monitor:noGpus')}
                </div>
              )}
            </div>

            {liveGpuUsage.length > 0 && (
              <div className="mt-5 pt-4 border-t border-border/60 space-y-4">
                <div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Combined live VRAM
                    </span>
                    <span className="text-foreground">
                      {formatMegaBytes(aggregateGpu.used)} /{' '}
                      {formatMegaBytes(aggregateGpu.total)}
                    </span>
                  </div>
                  <Progress
                    value={
                      aggregateGpu.total > 0
                        ? (aggregateGpu.used / aggregateGpu.total) * 100
                        : 0
                    }
                    className="h-2 w-full mt-2"
                  />
                </div>

                {liveGpuUsage.map((usage) => {
                  const gpu = hardwareData.gpus.find(
                    (candidate) => candidate.uuid === usage.uuid
                  )
                  const powerPercent =
                    typeof usage.power_w === 'number' &&
                    typeof usage.power_limit_w === 'number' &&
                    usage.power_limit_w > 0
                      ? (usage.power_w / usage.power_limit_w) * 100
                      : null
                  return (
                    <div
                      key={usage.uuid}
                      className="rounded-md border border-border/60 p-3 space-y-2"
                    >
                      <div className="font-medium text-sm">
                        {gpu?.name ?? usage.uuid}
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        <span className="text-muted-foreground">GPU load</span>
                        <span className="text-right">
                          {typeof usage.utilization_percent === 'number'
                            ? `${usage.utilization_percent}%`
                            : '—'}
                        </span>
                        <span className="text-muted-foreground">VRAM</span>
                        <span className="text-right">
                          {formatMegaBytes(usage.used_memory)} /{' '}
                          {formatMegaBytes(usage.total_memory)}
                        </span>
                        <span className="text-muted-foreground">
                          Temperature
                        </span>
                        <span className="text-right">
                          {typeof usage.temperature_c === 'number'
                            ? `${usage.temperature_c} °C`
                            : '—'}
                        </span>
                        <span className="text-muted-foreground">Power</span>
                        <span className="text-right">
                          {typeof usage.power_w === 'number'
                            ? `${usage.power_w.toFixed(1)} W`
                            : '—'}
                          {typeof usage.power_limit_w === 'number' &&
                            ` / ${usage.power_limit_w.toFixed(1)} W`}
                        </span>
                        <span className="text-muted-foreground">
                          Graphics clock
                        </span>
                        <span className="text-right">
                          {typeof usage.clock_graphics_mhz === 'number'
                            ? `${usage.clock_graphics_mhz} MHz`
                            : '—'}
                        </span>
                        <span className="text-muted-foreground">
                          Memory clock
                        </span>
                        <span className="text-right">
                          {typeof usage.clock_memory_mhz === 'number'
                            ? `${usage.clock_memory_mhz} MHz`
                            : '—'}
                        </span>
                      </div>
                      {typeof usage.utilization_percent === 'number' && (
                        <Progress
                          value={usage.utilization_percent}
                          className="h-2 w-full"
                        />
                      )}
                      {powerPercent !== null && (
                        <div className="text-xs text-muted-foreground">
                          {powerPercent.toFixed(1)}% of enforced power limit
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <PerformanceBenchmarkPanel />
    </div>
  )
}
