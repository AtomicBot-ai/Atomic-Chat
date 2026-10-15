import { useNavigate } from '@tanstack/react-router'
import { IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { DeleteModelAction } from '@/containers/hub/DeleteModelAction'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  cancelDownload,
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import { foundryLocalDownloadId } from '@/lib/foundry-local/download-id'
import {
  foundryLocalOf,
  hostFoundryLocalPlatform,
  pickDefaultVariant,
  variantLabel,
} from '@/lib/foundry-local/hub'
import { cn, formatBytes } from '@/lib/utils'
import { checkFoundryLocalVariant } from '@/services/foundry-local/core'
import { fetchFoundryLocalList } from '@/services/foundry-local/curated'
import { installFoundryLocalVariant } from '@/services/foundry-local/install'
import type {
  FoundryLocalCheckResult,
  FoundryLocalHubModel,
  FoundryLocalHubVariant,
} from '@/services/foundry-local/types'
import type { CatalogModel } from '@/services/models/types'
import { switchToModel } from '@/utils/switchModel'

const PROVIDER = 'foundry-local'

type Verdicts = Record<string, FoundryLocalCheckResult | { error: string }>

const verdictOf = (verdicts: Verdicts, variant: FoundryLocalHubVariant): string | undefined => {
  const entry = verdicts[variant.id]
  return entry && 'verdict' in entry ? entry.verdict : undefined
}

/**
 * The download part of a Foundry Local card (spec "Model Hub предлагает модели Foundry Local",
 * "Вариант по умолчанию выбирается под железо"): the variants this platform runs, each with the
 * core's verdict, one chosen by default — NPU, then GPU, then CPU among those that run here or will
 * once their accelerator is prepared — and the action for the chosen one:
 *
 * - "Download" when the core says it runs (`ok`): the installer, under one row of the download panel;
 * - "Install Foundry Local" / "Prepare the accelerator" when the engine or the accelerator is
 *   missing: the provider page, rather than downloading a model that cannot run;
 * - "New chat" and delete once the variant is on disk.
 *
 * A model of Microsoft's catalog says it is not verified by Atomic Chat: its files are checked by
 * size only.
 */
export function FoundryLocalDownloadOptions({
  model,
  sectionRef,
  platform = hostFoundryLocalPlatform(),
}: {
  model: CatalogModel
  sectionRef?: RefObject<HTMLElement | null>
  /** This machine's platform, as conf's lists name it; the build's own by default. */
  platform?: string
}) {
  const { t } = useTranslation()
  const fields = foundryLocalOf(model) as FoundryLocalHubModel
  const variants = useMemo(
    () => fields.variants.filter((variant) => variant.platforms.includes(platform)),
    [fields, platform]
  )
  const [verdicts, setVerdicts] = useState<Verdicts>({})
  const [picked, setPicked] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setVerdicts({})
    setPicked(null)
    void Promise.all(
      variants.map(async (variant) => {
        try {
          const check = await checkFoundryLocalVariant({
            execution_provider: variant.execution_provider,
            device: variant.device,
          })
          return [variant.id, check] as const
        } catch (error) {
          const message = (error as { message?: unknown } | null)?.message
          return [variant.id, { error: typeof message === 'string' ? message : String(error) }] as const
        }
      })
    ).then((entries) => {
      if (!cancelled) setVerdicts(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [variants])

  const providers = useModelProvider((state) => state.providers)
  const downloadedIds = useMemo(
    () =>
      new Set(
        providers
          .find((provider) => provider.provider === PROVIDER)
          ?.models.map((entry) => entry.id) ?? []
      ),
    [providers]
  )
  const downloaded = variants.find((variant) => downloadedIds.has(variant.id))
  const selected =
    variants.find((variant) => variant.id === picked) ??
    downloaded ??
    pickDefaultVariant(variants, (variant) => verdictOf(verdicts, variant)) ??
    variants[0]

  return (
    <section ref={sectionRef} className="scroll-mt-4 rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
      {fields.origin === 'microsoft' && (
        <p className="mb-3 text-xs text-muted-foreground">{t('hub:foundryLocal.notVerified')}</p>
      )}
      {variants.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('hub:foundryLocal.noVariantHere')}</p>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div role="radiogroup" className="flex min-w-0 flex-1 flex-col gap-1">
            {variants.map((variant) => {
              const entry = verdicts[variant.id]
              const checked = selected?.id === variant.id
              return (
                <button
                  key={variant.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={`${variantLabel(variant)} ${variant.id}`}
                  onClick={() => setPicked(variant.id)}
                  className={cn(
                    'flex w-full flex-col items-start rounded-md border border-transparent px-2 py-1.5 text-left hover:bg-accent',
                    checked && 'border-border bg-accent'
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{variantLabel(variant)}</span>
                    {variant.size_bytes !== null && (
                      <span className="text-xs text-muted-foreground">{formatBytes(variant.size_bytes)}</span>
                    )}
                  </span>
                  <VerdictLine entry={entry} downloaded={downloadedIds.has(variant.id)} />
                </button>
              )
            })}
          </div>
          {selected && (
            <div data-testid="foundry-local-actions">
              <Action
                fields={fields}
                variant={selected}
                verdict={verdicts[selected.id]}
                downloaded={downloadedIds.has(selected.id)}
              />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function VerdictLine({
  entry,
  downloaded,
}: {
  entry: Verdicts[string] | undefined
  downloaded: boolean
}) {
  const { t } = useTranslation()
  const text = downloaded
    ? t('hub:foundryLocal.downloaded')
    : !entry
      ? t('hub:foundryLocal.checking')
      : 'error' in entry
        ? entry.error
        : entry.verdict === 'ok'
          ? t('hub:foundryLocal.runsHere')
          : (entry.reason ?? entry.verdict)
  return <span className="text-xs text-muted-foreground">{text}</span>
}

function Action({
  fields,
  variant,
  verdict,
  downloaded,
}: {
  fields: FoundryLocalHubModel
  variant: FoundryLocalHubVariant
  verdict: Verdicts[string] | undefined
  downloaded: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toProviderPage = () =>
    navigate({ to: route.settings.providers, params: { providerName: PROVIDER } })

  if (downloaded) return <InstalledActions modelId={variant.id} />
  if (!verdict || 'error' in verdict) return null
  if (verdict.verdict === 'engine-not-installed') {
    return (
      <Button size="sm" variant="outline" onClick={toProviderPage}>
        {t('hub:foundryLocal.installEngine')}
      </Button>
    )
  }
  if (verdict.verdict === 'accelerator-not-prepared') {
    return (
      <Button size="sm" variant="outline" onClick={toProviderPage}>
        {t('hub:foundryLocal.prepareAccelerator')}
      </Button>
    )
  }
  if (verdict.verdict !== 'ok') return null
  return <DownloadButton fields={fields} variant={variant} />
}

function DownloadButton({
  fields,
  variant,
}: {
  fields: FoundryLocalHubModel
  variant: FoundryLocalHubVariant
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const downloadId = foundryLocalDownloadId(variant.id)
  const progress = useDownloadStore((state) => state.downloads[downloadId]?.progress ?? 0)
  const isDownloading = useDownloadStore(
    (state) => state.localDownloadingModels.has(downloadId) || downloadId in state.downloads
  )
  const [failure, setFailure] = useState<string | null>(null)

  const download = useCallback(async () => {
    const store = useDownloadStore.getState()
    setFailure(null)
    store.clearResumableDownload(downloadId)
    // The download panel names the row after this, not after the id.
    store.setDownloadOrigin(downloadId, `${fields.name} (${variantLabel(variant)})`)
    store.addLocalDownloadingModel(downloadId)
    try {
      const { list } = await fetchFoundryLocalList()
      if (!list) throw new Error(t('hub:foundryLocal.sourceUnavailable'))
      await installFoundryLocalVariant({ model: fields, variant, list })
      // A variant is a model once `model.yml` is written: list it, so the card offers a chat.
      useModelProvider.getState().setProviders(await serviceHub.providers().getProviders())
    } catch (error) {
      // A cancel is the person's own doing, not a failure to report.
      if (!wasDownloadCancellationRequested(downloadId) && !isDownloadCancellationError(error)) {
        setFailure(error instanceof Error ? error.message : String(error))
      }
    } finally {
      useDownloadStore.getState().removeLocalDownloadingModel(downloadId)
    }
  }, [downloadId, fields, variant, serviceHub, t])

  return (
    <div className="flex max-w-60 flex-col items-end gap-2">
      {isDownloading ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => cancelDownload({ id: downloadId, name: downloadId }, serviceHub)}
          title={t('common:cancelDownload')}
          aria-label={t('common:cancelDownload')}
          className="group relative w-24 justify-center overflow-hidden font-semibold"
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 z-0 bg-primary/20 transition-[width] duration-200"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
          <span className="relative z-1 tabular-nums transition-opacity group-hover:opacity-0">
            {Math.round(progress * 100)}%
          </span>
          <span className="absolute inset-0 z-1 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <IconX size={14} />
          </span>
        </Button>
      ) : (
        <Button size="sm" onClick={() => void download()}>
          {t('hub:download')}
        </Button>
      )}
      {failure && <p className="text-right text-xs text-destructive">{failure}</p>}
    </div>
  )
}

/** "New chat" on `foundry-local` with the variant, and delete with the space it frees. */
function InstalledActions({ modelId }: { modelId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()

  const newChat = useCallback(() => {
    useModelProvider.getState().selectModelProvider(PROVIDER, modelId)
    switchToModel({ modelId, providerName: PROVIDER, serviceHub }).catch((error) => {
      console.error('[FoundryLocalDownloadOptions] switchToModel failed:', error)
    })
    navigate({
      to: route.home,
      params: {},
      search: { threadModel: { id: modelId, provider: PROVIDER } },
    })
  }, [modelId, navigate, serviceHub])

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button size="sm" onClick={newChat}>
        {t('hub:newChat')}
      </Button>
      <DeleteModelAction modelId={modelId} provider={PROVIDER} />
    </div>
  )
}
