import { createFileRoute, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  IconCircleCheck,
  IconPlugConnected,
  IconChevronDown,
  IconChevronRight,
  IconRadar,
  IconX,
} from '@tabler/icons-react'
import { route } from '@/constants/routes'
import SettingsMenu from '@/containers/SettingsMenu'
import HeaderPage from '@/containers/HeaderPage'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OllamaPanel } from '@/containers/runtimes/OllamaPanel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  connectRuntime,
  connectTarget,
  isConnected,
  type ConnectTarget,
} from '@/lib/connect-runtime'
import {
  countByTier,
  detectRuntimes,
  detectionName,
  filterRuntimes,
  formatCount,
  listRuntimes,
  TIER_ORDER,
  type RuntimeDescriptor,
  type RuntimeDetection,
  type RuntimeFilter,
} from '@/services/runtimes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.runtimes as any)({
  component: RuntimesSettings,
})

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function Chip({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode
  tone?: 'muted' | 'good' | 'warn'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'muted' && 'bg-secondary text-muted-foreground',
        tone === 'good' &&
          'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
        tone === 'warn' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
      )}
    >
      {children}
    </span>
  )
}

function DetectionActions({
  target,
  connected,
  connecting,
  onConnect,
}: {
  target: ConnectTarget | null
  connected: boolean
  connecting: boolean
  onConnect: () => void
}) {
  const { t } = useTranslation()
  if (!target) return null
  if (target.kind === 'media') {
    return (
      <Button asChild size="xs" variant="outline">
        <Link to={route.settings.media}>
          {t('settings:runtimes.setUpInMedia')}
        </Link>
      </Button>
    )
  }
  if (connected) {
    return (
      <span className="flex items-center gap-2">
        <Chip tone="good">{t('settings:runtimes.connected')}</Chip>
        <Button
          size="xs"
          variant="ghost"
          onClick={onConnect}
          disabled={connecting}
        >
          {t('settings:runtimes.refreshModels')}
        </Button>
      </span>
    )
  }
  return (
    <Button size="xs" onClick={onConnect} disabled={connecting}>
      <IconPlugConnected />
      {connecting
        ? t('settings:runtimes.connecting')
        : t('settings:runtimes.connect')}
    </Button>
  )
}

function DetectionRow({
  detection,
  byId,
  actions,
}: {
  detection: RuntimeDetection
  byId: Map<string, RuntimeDescriptor>
  actions?: React.ReactNode
}) {
  const { t } = useTranslation()
  const generated = formatCount(detection.counters?.generated_tokens_total)
  const running = detection.counters?.requests_running
  return (
    <li className="flex flex-col gap-1 border-b border-border/40 pb-3 last:border-none last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">
          {detectionName(detection, byId)}
        </span>
        {detection.confidence === 'confirmed' ? (
          <Chip tone="good">{t('settings:runtimes.confirmed')}</Chip>
        ) : (
          <Chip tone="warn">{t('settings:runtimes.portGuess')}</Chip>
        )}
        {detection.version && <Chip>{detection.version}</Chip>}
        <span className="text-xs text-muted-foreground font-mono">
          {detection.baseUrl}
        </span>
        {actions && <span className="ml-auto">{actions}</span>}
      </div>
      <div className="text-sm text-muted-foreground">
        {[
          // ComfyUI and InvokeAI list no models through this API; say nothing
          // rather than "Models: 0".
          detection.models.length > 0 &&
            t('settings:runtimes.modelCount', {
              count: detection.models.length,
            }),
          detection.loadedModels.length > 0 &&
            `${t('settings:runtimes.loaded')}: ${detection.loadedModels.join(', ')}`,
          generated &&
            t('settings:runtimes.tokensGenerated', { count: generated }),
          typeof running === 'number' &&
            t('settings:runtimes.requestsRunning', { count: running }),
        ]
          .filter(Boolean)
          .join(' · ')}
      </div>
      {detection.devices.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {detection.devices
            .map((device) =>
              device.vramTotalMib
                ? `${device.name} (${device.vramFreeMib ?? '?'} / ${device.vramTotalMib} MiB free)`
                : device.name
            )
            .join(' · ')}
        </div>
      )}
      {detection.runtimeId && detection.alternatives.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {t('settings:runtimes.orPossibly', {
            names: detection.alternatives
              .map((id) => byId.get(id)?.name ?? id)
              .join(', '),
          })}
        </div>
      )}
    </li>
  )
}

function CatalogRow({
  runtime,
  open,
  onToggle,
}: {
  runtime: RuntimeDescriptor
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  return (
    <li className="border-b border-border/40 last:border-none">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-2 text-left hover:bg-secondary/50 rounded-sm px-1"
      >
        {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        <span className="font-medium text-foreground">{runtime.name}</span>
        <Chip>{t(`settings:runtimes.tier.${runtime.tier}`)}</Chip>
        <span className="text-xs text-muted-foreground">
          {t(`settings:runtimes.mode.${runtime.mode}`)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {runtime.maintenance !== 'active' && (
            <Chip tone="warn">
              {t(`settings:runtimes.maintenance.${runtime.maintenance}`)}
            </Chip>
          )}
          <span className="text-xs text-muted-foreground">
            {runtime.license.spdx}
          </span>
          {runtime.verified && (
            <IconCircleCheck
              size={14}
              className="text-emerald-600"
              aria-label={t('settings:runtimes.verified', {
                date: runtime.verified_on,
              })}
            />
          )}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 pb-3 pl-6 text-sm text-muted-foreground">
          <p className="text-foreground">{runtime.note}</p>
          <p>
            {t('settings:runtimes.formats')}:{' '}
            {runtime.formats.join(', ') || '—'} ·{' '}
            {t('settings:runtimes.capabilities')}:{' '}
            {runtime.capabilities.join(', ') || '—'}
          </p>
          <p>
            Windows: {runtime.platforms.windows} · Linux:{' '}
            {runtime.platforms.linux} · macOS: {runtime.platforms.macos}
            {runtime.default_port !== null && (
              <>
                {' '}
                · {t('settings:runtimes.port')}: {runtime.default_port}
              </>
            )}
            {runtime.wraps.length > 0 && (
              <>
                {' '}
                · {t('settings:runtimes.wraps')}: {runtime.wraps.join(', ')}
              </>
            )}
          </p>
          <a
            href={runtime.source_url}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline w-fit"
          >
            {runtime.source_url}
          </a>
        </div>
      )}
    </li>
  )
}

function RuntimesSettings() {
  const { t } = useTranslation()
  const [catalog, setCatalog] = useState<RuntimeDescriptor[]>([])
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [detections, setDetections] = useState<RuntimeDetection[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [extra, setExtra] = useState<string[]>([])
  const [filter, setFilter] = useState<RuntimeFilter>({
    tier: 'all',
    query: '',
  })
  const [openId, setOpenId] = useState<string | null>(null)
  // The full catalog is reference material: folded away until asked for.
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [connectingUrl, setConnectingUrl] = useState<string | null>(null)
  const serviceHub = useServiceHub()
  const { providers, addProvider, updateProvider } = useModelProvider()

  useEffect(() => {
    listRuntimes()
      .then(setCatalog)
      .catch((error) => setCatalogError(errorText(error)))
  }, [])

  const byId = useMemo(
    () => new Map(catalog.map((runtime) => [runtime.id, runtime])),
    [catalog]
  )
  const counts = useMemo(() => countByTier(catalog), [catalog])
  const rows = useMemo(() => filterRuntimes(catalog, filter), [catalog, filter])

  const scan = useCallback(async () => {
    setScanning(true)
    setScanError(null)
    try {
      setDetections(await detectRuntimes(extra))
    } catch (error) {
      setScanError(errorText(error))
    } finally {
      setScanning(false)
    }
  }, [extra])

  const connect = useCallback(
    async (detection: RuntimeDetection, target: ConnectTarget | null) => {
      if (!target || target.kind !== 'provider') return
      setConnectingUrl(detection.baseUrl)
      try {
        const result = await connectRuntime(target, detection.models, {
          providers: useModelProvider.getState().providers,
          addProvider,
          updateProvider,
          getProviderByName: (name) =>
            useModelProvider.getState().getProviderByName(name),
          serviceHub,
        })
        toast.success(
          t('settings:runtimes.connectedToast', {
            name: result.providerId,
            count: result.modelCount,
          })
        )
      } catch (error) {
        toast.error(t('settings:runtimes.connectFailed'), {
          description: errorText(error),
        })
      } finally {
        setConnectingUrl(null)
      }
    },
    [addProvider, updateProvider, serviceHub, t]
  )
  const addAddress = () => {
    const value = address.trim()
    if (value && !extra.includes(value)) setExtra([...extra, value])
    setAddress('')
  }

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col gap-4 w-full">
            <Card
              header={
                <div className="mb-3">
                  <h1 className="font-medium text-foreground text-base">
                    {t('settings:runtimes.yourRuntimesTitle')}
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    {t('settings:runtimes.yourRuntimesDesc')}
                  </p>
                </div>
              }
            >
              <OllamaPanel />
            </Card>

            <Card
              header={
                <div className="flex items-center justify-between mb-2 gap-4">
                  <div>
                    <h1 className="font-medium text-foreground text-base">
                      {t('settings:runtimes.runningTitle')}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      {t('settings:runtimes.runningDesc')}
                    </p>
                  </div>
                  <Button size="sm" onClick={scan} disabled={scanning}>
                    <IconRadar />
                    {scanning
                      ? t('settings:runtimes.scanning')
                      : t('settings:runtimes.scan')}
                  </Button>
                </div>
              }
            >
              <div className="flex gap-2 mb-3">
                <Input
                  value={address}
                  placeholder="http://192.168.1.20:11434"
                  aria-label={t('settings:runtimes.addAddress')}
                  onChange={(event) => setAddress(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && addAddress()}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addAddress}
                  disabled={!address.trim()}
                >
                  {t('settings:runtimes.addAddress')}
                </Button>
              </div>
              {extra.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {extra.map((url) => (
                    <span
                      key={url}
                      className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs font-mono"
                    >
                      {url}
                      <button
                        type="button"
                        aria-label={t('settings:runtimes.remove', { url })}
                        onClick={() =>
                          setExtra(extra.filter((item) => item !== url))
                        }
                      >
                        <IconX size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {scanError && (
                <p className="text-sm text-destructive">{scanError}</p>
              )}
              {detections === null && !scanError && (
                <p className="text-sm text-muted-foreground">
                  {t('settings:runtimes.notScanned')}
                </p>
              )}
              {detections !== null && detections.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t('settings:runtimes.noneFound')}
                </p>
              )}
              {detections !== null && detections.length > 0 && (
                <ul
                  className="flex flex-col gap-3"
                  data-testid="runtime-detections"
                >
                  {detections.map((detection) => {
                    const target = connectTarget(detection, byId)
                    return (
                      <DetectionRow
                        key={detection.baseUrl}
                        detection={detection}
                        byId={byId}
                        actions={
                          <DetectionActions
                            target={target}
                            connected={isConnected(target, providers)}
                            connecting={connectingUrl === detection.baseUrl}
                            onConnect={() => connect(detection, target)}
                          />
                        }
                      />
                    )
                  })}
                </ul>
              )}
            </Card>

            <Card
              header={
                <div className="flex flex-col gap-2 mb-2">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h1 className="font-medium text-foreground text-base">
                        {t('settings:runtimes.catalogTitle', {
                          count: catalog.length,
                        })}
                      </h1>
                      <p className="text-sm text-muted-foreground">
                        {t('settings:runtimes.catalogDesc')}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-expanded={catalogOpen}
                      onClick={() => setCatalogOpen(!catalogOpen)}
                    >
                      {catalogOpen
                        ? t('settings:runtimes.hideCatalog')
                        : t('settings:runtimes.showCatalog')}
                    </Button>
                  </div>
                  {catalogOpen && (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {(['all', ...TIER_ORDER] as const).map((tier) => (
                          <Button
                            key={tier}
                            size="xs"
                            variant={
                              filter.tier === tier ? 'default' : 'outline'
                            }
                            onClick={() => setFilter({ ...filter, tier })}
                          >
                            {tier === 'all'
                              ? t('settings:runtimes.all', {
                                  count: catalog.length,
                                })
                              : `${t(`settings:runtimes.tier.${tier}`)} (${counts[tier]})`}
                          </Button>
                        ))}
                      </div>
                      <Input
                        value={filter.query}
                        placeholder={t('settings:runtimes.search')}
                        aria-label={t('settings:runtimes.search')}
                        onChange={(event) =>
                          setFilter({ ...filter, query: event.target.value })
                        }
                      />
                    </>
                  )}
                </div>
              }
            >
              {catalogError && (
                <p className="text-sm text-destructive">{catalogError}</p>
              )}
              {catalogOpen && (
                <ul data-testid="runtime-catalog">
                  {rows.map((runtime) => (
                    <CatalogRow
                      key={runtime.id}
                      runtime={runtime}
                      open={openId === runtime.id}
                      onToggle={() =>
                        setOpenId(openId === runtime.id ? null : runtime.id)
                      }
                    />
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
