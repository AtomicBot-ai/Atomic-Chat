import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { geniexAccelerators } from '@/services/geniex/core'
import type { GeniexAccelerator, GeniexAccelerators as AcceleratorsAnswer } from '@/services/geniex/types'

const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(error)
}

/**
 * The devices block of the GenieX provider page (spec `geniex-desktop`, "Страница провайдера ставит
 * движок и показывает устройства"): what the SDK's library found on this laptop when the build was
 * installed — the Hexagon NPU (`npu`) and the Adreno GPU (`gpu`) — read from the core's accelerators
 * answer. There is no Prepare: everything a device needs ships inside the SDK, so each listed device
 * is ready the moment it is listed. Without the NPU the block says the Qualcomm NPU driver is what
 * is missing. Nothing is shown before the SDK is installed; the page reads again when the active
 * build changes, since a new build is probed afresh.
 */
export function GeniexDevices() {
  const { t } = useTranslation()
  const [answer, setAnswer] = useState<AcceleratorsAnswer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const read = useCallback(async () => {
    try {
      setAnswer(await geniexAccelerators())
      setLoadError(null)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [])

  useEffect(() => {
    void read()
  }, [read])

  if (loadError) {
    return (
      <Card header={<Header />}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">{loadError}</p>
          <CheckAgain onClick={() => void read()} />
        </div>
      </Card>
    )
  }
  if (!answer || !answer.installed) return null
  if (answer.error) {
    return (
      <Card header={<Header />}>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">{answer.error}</p>
          <CheckAgain onClick={() => void read()} />
        </div>
      </Card>
    )
  }

  const found = (device: string) => answer.accelerators.some((accelerator) => accelerator.device === device)

  return (
    <Card header={<Header />}>
      {answer.accelerators.map((accelerator) => (
        <div
          key={accelerator.name}
          data-testid={`geniex-device-${accelerator.name}`}
          className="border-b border-border/40 py-3 first:pt-0 last:border-none last:pb-0"
        >
          <CardItem
            className="items-baseline"
            title={t(deviceTitleKey(accelerator))}
            description={t('providers:geniex.devices.detail', { version: accelerator.version })}
            actions={
              <span className="text-xs text-emerald-600 dark:text-emerald-400">
                {t('providers:geniex.devices.ready')}
              </span>
            }
          />
        </div>
      ))}
      {answer.accelerators.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('providers:geniex.devices.none')}</p>
      )}
      {!found('npu') && (
        <p className="mt-3 text-sm text-muted-foreground">{t('providers:geniex.devices.npuDriverHint')}</p>
      )}
    </Card>
  )
}

/** How a device reads on the page: the NPU and the GPU by name; anything newer by the core's word. */
function deviceTitleKey(accelerator: GeniexAccelerator): string {
  if (accelerator.device === 'npu') return 'providers:geniex.devices.npu'
  if (accelerator.device === 'gpu') return 'providers:geniex.devices.gpu'
  return accelerator.name
}

function CheckAgain({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      {t('providers:geniex.devices.checkAgain')}
    </Button>
  )
}

function Header() {
  const { t } = useTranslation()
  return (
    <div className="mb-4 space-y-1">
      <h1 className="text-foreground font-medium text-base">{t('providers:geniex.devices.title')}</h1>
      <p className="text-sm">{t('providers:geniex.devices.description')}</p>
    </div>
  )
}
