import { useEffect, useState } from 'react'
import { strataCanonicalDescriptor } from '@atomic-chat/core/client'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown } from 'lucide-react'
import type {
  StrataCheckResult,
  StrataModelDescriptor,
} from '@atomic-chat/core/contracts'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DeleteModelAction } from '@/containers/hub/DeleteModelAction'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, formatBytes } from '@/lib/utils'
import { engineBuildCatalog } from '@/services/engine-builds/core'
import { installStrataEngine } from '@/services/strata/engine'
import { checkStrataModel, syncStrataSettings } from '@/services/strata/core'
import {
  cancelStrata,
  installStrata,
  listStrataJobs,
  resumeStrata,
  strataTaskId,
} from '@/services/strata/install'
import { switchToModel } from '@/utils/switchModel'
import { route } from '@/constants/routes'

function quantLabel(name: string) {
  // Catalog names carry the quant label as a suffix, including special precision profiles.
  return name.match(/\b(?:(?:UD-)?I?Q\d(?:_[a-z0-9]+)+(?:-v\d+)?|NVFP4[- ][a-z0-9]+|Gyro-[SM]|\d+(?:\.\d+)? bpw|ISTA-DAS Coder)$/i)?.[0] ?? name
}

export function StrataQuantSelect({
  variants,
  selectedId,
  onChange,
  className,
}: {
  variants: readonly StrataModelDescriptor[]
  selectedId: string
  onChange: (id: string) => void
  className?: string
}) {
  const { t } = useTranslation()
  if (variants.length < 2) return null
  const selected = variants.find((variant) => variant.variant_id === selectedId) ?? variants[0]!
  const label = quantLabel(selected.name)

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('w-full min-w-0 justify-start rounded-md', className)}
          aria-label={`${t('hub:strata.quantization')}: ${label}`}
        >
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatBytes(selected.requirements.download_bytes)}
          </span>
          <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-max max-w-(--radix-dropdown-menu-content-available-width)"
      >
        <DropdownMenuRadioGroup value={selected.variant_id} onValueChange={onChange}>
          {variants.map((variant) => (
            <DropdownMenuRadioItem
              key={variant.variant_id}
              value={variant.variant_id}
              className="justify-between gap-4"
            >
              <span className="min-w-0 break-words">{quantLabel(variant.name)}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatBytes(variant.requirements.download_bytes)}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function StrataDownloadOptions({
  descriptor,
  variants,
  onVariantChange,
}: {
  descriptor: StrataModelDescriptor
  variants?: readonly StrataModelDescriptor[]
  onVariantChange?: (id: string) => void
}) {
  const [selectedId, setSelectedId] = useState<string>()
  const installed = useModelProvider((state) =>
    state.providers.find((provider) => provider.provider === 'strata')?.models
  )
  const selected = onVariantChange
    ? descriptor
    : variants?.find((variant) => variant.variant_id === selectedId) ??
      variants?.find((variant) => installed?.some((model) => model.id === variant.variant_id)) ??
      descriptor

  return (
    <div className="min-w-0 space-y-3">
      {variants && (
        <StrataQuantSelect
          variants={variants}
          selectedId={selected.variant_id}
          onChange={onVariantChange ?? setSelectedId}
        />
      )}
      <StrataVariantDownloadOptions key={selected.variant_id} descriptor={selected} />
    </div>
  )
}

function StrataVariantDownloadOptions({ descriptor }: { descriptor: StrataModelDescriptor }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const token = useGeneralSetting((state) => state.huggingfaceToken)
  const id = descriptor.variant_id
  const task = strataTaskId(id)
  const installed = useModelProvider((state) =>
    state.providers
      .find((p) => p.provider === 'strata')
      ?.models.find((model) => model.id === id)
  )
  const updateAvailable =
    !!installed?.strata &&
    strataCanonicalDescriptor(installed.strata) !==
      strataCanonicalDescriptor(descriptor)
  const progress = useDownloadStore((state) => state.downloads[task])
  const [check, setCheck] = useState<StrataCheckResult>()
  const [engine, setEngine] =
    useState<Awaited<ReturnType<typeof engineBuildCatalog>>>()
  const [resume, setResume] = useState<boolean>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let active = true
    setCheck(undefined)
    setResume(undefined)
    setEngine(undefined)
    setProblem(undefined)
    void (async () => {
      try {
        // Query the engine first: older cores reject the engine id even when
        // the local catalog contains Strata models.
        const build = await engineBuildCatalog('strata')
        if (active) setEngine(build)
        if (build.active) await syncStrataSettings()
        const verdict = await checkStrataModel({ descriptor })
        const jobs = await listStrataJobs()
        if (!active) return
        setCheck(verdict)
        setResume(
          jobs.some((job) => job.model_id === id && job.state !== 'ready')
        )
      } catch (error) {
        if (!active) return
        const code = (error as { code?: string })?.code
        setProblem(
          code === 'INVALID_ARGUMENT' ||
            code === 'PROVIDER_NOT_FOUND' ||
            code === 'NOT_FOUND'
            ? t('hub:strata.updateApp')
            : ((error as { message?: string })?.message ?? String(error))
        )
      }
    })()
    return () => {
      active = false
    }
  }, [descriptor, id, refresh, t])

  const estimates = check?.estimates
  const offered = engine?.host_backend_id
  const needsEngine =
    check?.verdict === 'engine-not-installed' ||
    check?.verdict === 'requires-newer-engine'
  const canInstallEngine = !!(
    needsEngine &&
    offered &&
    descriptor.compatible_variants.includes(offered)
  )
  const canAcquire = check?.verdict === 'ok' && (!descriptor.gated || !!token)
  const explanation =
    needsEngine && !canInstallEngine
      ? offered
        ? t('hub:strata.unsupportedBundle')
        : (engine?.host_reason ?? check?.reason)
      : check?.reason

  async function run(action: 'engine' | 'download' | 'import' | 'resume') {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    let succeeded = false
    try {
      if (action === 'engine') {
        await installStrataEngine()
      } else if (action === 'resume') {
        await resumeStrata(task, token)
      } else {
        const folder =
          action === 'import'
            ? await serviceHub
                .dialog()
                .open({ directory: true, multiple: false })
            : undefined
        if (action === 'import' && typeof folder !== 'string') return
        await installStrata(
          descriptor,
          token,
          typeof folder === 'string' ? folder : undefined
        )
      }
      succeeded = true
    } catch (error) {
      setProblem((error as { message?: string })?.message ?? String(error))
      setResume(
        (await listStrataJobs().catch(() => [])).some(
          (job) => job.model_id === id && job.state !== 'ready'
        )
      )
    } finally {
      setBusy(false)
      if (succeeded) setRefresh((value) => value + 1)
    }
  }

  const actual = check?.capabilities
  const capabilities = [
    actual?.tools ? t('hub:strata.tools') : null,
    actual?.reasoning ? t('hub:strata.reasoning') : null,
    actual?.vision ? t('hub:strata.images') : null,
    actual?.structured_output ? t('hub:strata.structuredOutput') : null,
  ].filter(Boolean)

  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border p-4"
      aria-label={t('hub:strata.install')}
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt>{t('hub:strata.downloadSize')}</dt>
        <dd>{formatBytes(descriptor.requirements.download_bytes)}</dd>
        <dt>{t('hub:strata.license')}</dt>
        <dd className="break-words">{descriptor.license}</dd>
        {estimates && (
          <>
            <dt>{t('hub:strata.disk')}</dt>
            <dd>{formatBytes(estimates.required_disk_bytes)}</dd>
            {estimates.unified_memory_bytes > 0 ? (
              <>
                <dt>{t('hub:strata.unifiedMemory')}</dt>
                <dd>{formatBytes(estimates.unified_memory_bytes)}</dd>
              </>
            ) : (
              <>
                <dt>RAM</dt>
                <dd>{formatBytes(estimates.ram_bytes)}</dd>
                <dt>VRAM</dt>
                <dd>{formatBytes(estimates.vram_bytes)}</dd>
              </>
            )}
          </>
        )}
        {canInstallEngine && !!engine?.host_download_bytes && (
          <>
            <dt>{t('hub:strata.engineSize')}</dt>
            <dd>{formatBytes(engine.host_download_bytes)}</dd>
          </>
        )}
      </dl>
      {capabilities.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {capabilities.join(' · ')}
        </p>
      )}
      {descriptor.qualification.status === 'upstream-supported' && (
        <p className="text-xs text-muted-foreground">
          {t('hub:strata.upstreamSupported')}
        </p>
      )}
      {check?.warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
      {explanation && (
        <p role="status" className="text-sm">
          {explanation}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {!check && !problem && (
        <p role="status" className="text-sm">
          {t('hub:strata.checking')}
        </p>
      )}
      {descriptor.gated && !token && (
        <Button
          variant="outline"
          onClick={() => void navigate({ to: route.settings.general })}
        >
          {t('hub:strata.setToken')}
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {installed && engine?.active && resume === false && !busy && (
          <>
            <Button
              onClick={() => {
                useModelProvider.getState().selectModelProvider('strata', id)
                void switchToModel({
                  modelId: id,
                  providerName: 'strata',
                  serviceHub,
                }).catch((error) => setProblem(String(error)))
                void navigate({
                  to: route.home,
                  params: {},
                  search: { threadModel: { id, provider: 'strata' } },
                })
              }}
            >
              {t('hub:strata.chat')}
            </Button>
            <DeleteModelAction provider="strata" modelId={id} />
            {updateAvailable && (
              <Button
                variant="outline"
                disabled={!canAcquire}
                onClick={() => void run('download')}
              >
                {t('hub:strata.updateModel')}
              </Button>
            )}
          </>
        )}
        {canInstallEngine && (
          <Button disabled={busy} onClick={() => void run('engine')}>
            {t('hub:strata.installEngine')}
          </Button>
        )}
        {progress &&
          !canInstallEngine &&
          (busy || progress.stage?.kind === 'strata-preparing') && (
            <>
              <span className="text-sm" role="status">
                {progress.stage?.kind === 'strata-preparing'
                  ? t('hub:strata.preparing')
                  : t('hub:strata.acquiring')}
              </span>
              <Button variant="outline" onClick={() => void cancelStrata(task)}>
                {t('hub:strata.cancel')}
              </Button>
            </>
          )}
        {resume && !busy && (
          <Button onClick={() => void run('resume')}>
            {t('hub:strata.resume')}
          </Button>
        )}
        {resume !== true && !installed && !canInstallEngine && (
          <>
            <Button
              disabled={resume === undefined || !canAcquire || busy}
              onClick={() => void run('download')}
            >
              {t('hub:strata.install')}
            </Button>
            <Button
              variant="outline"
              disabled={resume === undefined || check?.verdict !== 'ok' || busy}
              onClick={() => void run('import')}
            >
              {t('hub:strata.import')}
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
