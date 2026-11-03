import { useNavigate } from '@tanstack/react-router'
import { IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'

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
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { liteRtLmDownloadId } from '@/lib/litert-lm/download-id'
import {
  hostLiteRtLmPlatform,
  liteRtLmOf,
  liteRtLmVariantLabel as variantLabel,
  pickDefaultLiteRtLmVariant,
} from '@/lib/litert-lm/hub'
import { cn, formatBytes } from '@/lib/utils'
import { checkLiteRtLmModel } from '@/services/litert-lm/core'
import { installLiteRtLmVariant } from '@/services/litert-lm/install'
import { GatedModelError } from '@/services/managed-models/models'
import type {
  LiteRtLmCheckResult,
  LiteRtLmHubModel,
  LiteRtLmHubVariant,
} from '@/services/litert-lm/types'
import type { CatalogModel } from '@/services/models/types'
import { switchToModel } from '@/utils/switchModel'

const PROVIDER = 'litert-lm'

type Verdicts = Record<string, LiteRtLmCheckResult | { error: string }>

const verdictOf = (verdicts: Verdicts, variant: LiteRtLmHubVariant): string | undefined => {
  const entry = verdicts[variant.id]
  return entry && 'verdict' in entry ? entry.verdict : undefined
}

/**
 * The download part of a LiteRT-LM card (change `add-litert-lm-runtime`, spec `litert-lm-desktop`
 * "Model Hub предлагает модели LiteRT-LM", spec `litert-lm-models` "Вариант по умолчанию
 * выбирается под железо"): the variants this platform runs, each with the core's verdict, one chosen
 * by default — NPU, then GPU, then CPU among those that run here or will once OpenVINO is prepared —
 * and the action for the chosen one:
 *
 * - "Download" when the core says it runs (`ok`): the installer, under one row of the download panel;
 * - "Install LiteRT-LM" / "Prepare OpenVINO" when the engine or the accelerator is missing: the
 *   provider page, rather than downloading a model that cannot run;
 * - "New chat" and delete once the variant is on disk.
 *
 * A gated repository without the person's Hugging Face token says what to do — accept the terms on
 * its page, set the token in Settings — and downloads nothing until the token is there. A Hugging
 * Face model says it is not verified by Atomic Chat.
 */
export function LiteRtLmDownloadOptions({
  model,
  sectionRef,
  platform = hostLiteRtLmPlatform(),
}: {
  model: CatalogModel
  sectionRef?: RefObject<HTMLElement | null>
  /** This machine's platform, as conf's lists name it; the build's own by default. */
  platform?: string
}) {
  const { t } = useTranslation()
  const fields = liteRtLmOf(model) as LiteRtLmHubModel
  const token = useGeneralSetting((state) => state.huggingfaceToken)
  const needsToken = fields.gated && !token
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
          const check = await checkLiteRtLmModel({
            backend: variant.backend,
            ...(variant.npu ? { npu: variant.npu } : {}),
            ...(variant.min_runtime_version ? { min_runtime_version: variant.min_runtime_version } : {}),
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
    pickDefaultLiteRtLmVariant(variants, (variant) => verdictOf(verdicts, variant)) ??
    variants[0]

  // A variant found on disk in "Downloaded": nothing to choose or check, only chat and delete.
  if (fields.origin === 'installed') {
    return (
      <section ref={sectionRef} className="scroll-mt-4 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{fields.name}</span>
          <ActionColumn trash={<DeleteModelAction modelId={fields.model_id} provider={PROVIDER} />}>
            <NewChatButton modelId={fields.model_id} />
          </ActionColumn>
        </div>
      </section>
    )
  }

  return (
    <section ref={sectionRef} className="scroll-mt-4 rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
      {fields.origin === 'huggingface' && (
        <p className="mb-3 text-xs text-muted-foreground">{t('hub:liteRtLm.notVerified')}</p>
      )}
      {needsToken && <GatedNotice repo={fields.repo} />}
      {variants.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('hub:liteRtLm.noVariantHere')}</p>
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
                    'flex w-full min-w-0 flex-col items-start rounded-md border border-transparent px-2 py-1.5 text-left hover:bg-accent',
                    checked && 'border-border bg-accent'
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{variantLabel(variant)}</span>
                    <span className="text-xs text-muted-foreground">{formatBytes(variant.file.size)}</span>
                  </span>
                  <VerdictLine entry={entry} downloaded={downloadedIds.has(variant.id)} />
                </button>
              )
            })}
          </div>
          {selected && (
            // One width whatever the chosen variant offers (Download, or New chat and delete):
            // sized by content, the column resized the list on every pick.
            <ActionColumn
              // The 32 px button centred on the first variant's name line: its border, its `py-1.5`
              // and half a `text-sm` line (1.25 × the app's font size, which a person can raise
              // while rem stays). Pinned to the top, the button rode up as the font grew.
              className="pt-[max(0px,calc(1px_+_0.375rem_+_var(--text-sm)_*_0.625_/_0.875_-_1rem))]"
              trash={
                downloadedIds.has(selected.id) ? (
                  <DeleteModelAction modelId={selected.id} provider={PROVIDER} />
                ) : null
              }
            >
              <Action
                // One per variant: a download running for one must not leave the next one picked
                // with its "busy" state (the store, not this state, shows a running download).
                key={selected.id}
                fields={fields}
                variant={selected}
                verdict={verdicts[selected.id]}
                downloaded={downloadedIds.has(selected.id)}
                token={token || undefined}
              />
            </ActionColumn>
          )}
        </div>
      )}
    </section>
  )
}

/** A gated repository without a token: what to accept where, and the way to the token setting. */
function GatedNotice({ repo }: { repo: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const url = `https://huggingface.co/${repo}`
  return (
    <div className="mb-3 flex flex-col items-start gap-2 rounded-md border border-border p-3 text-xs">
      <p>{t('hub:liteRtLm.gatedNoToken')}</p>
      <a className="break-all underline" href={url} target="_blank" rel="noreferrer">
        {repo}
      </a>
      <Button size="sm" variant="outline" onClick={() => navigate({ to: route.settings.general })}>
        {t('hub:liteRtLm.setToken')}
      </Button>
    </div>
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
    ? t('hub:liteRtLm.downloaded')
    : !entry
      ? t('hub:liteRtLm.checking')
      : 'error' in entry
        ? entry.error
        : entry.verdict === 'ok'
          ? t('hub:liteRtLm.runsHere')
          : (entry.reason ?? entry.verdict)
  // The core's reasons carry long library names (`WebGpuExecutionProvider`): break inside them.
  return <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{text}</span>
}

function Action({
  fields,
  variant,
  verdict,
  downloaded,
  token,
}: {
  fields: LiteRtLmHubModel
  variant: LiteRtLmHubVariant
  verdict: Verdicts[string] | undefined
  downloaded: boolean
  token: string | undefined
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toProviderPage = () =>
    navigate({ to: route.settings.providers, params: { providerName: PROVIDER } })

  if (downloaded) return <NewChatButton modelId={variant.id} />
  if (!verdict || 'error' in verdict) return null
  if (verdict.verdict === 'engine-not-installed') {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={toProviderPage}
        // The column is fixed; a long label wraps inside it rather than spilling over the list.
        // `h-auto!`: the shell's control-height rule in index.css pins `sm` buttons to one line.
        className="h-auto! max-w-full whitespace-normal py-1.5 text-center"
      >
        {t('hub:liteRtLm.installEngine')}
      </Button>
    )
  }
  if (verdict.verdict === 'accelerator-not-prepared') {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={toProviderPage}
        // The column is fixed; a long label wraps inside it rather than spilling over the list.
        // `h-auto!`: the shell's control-height rule in index.css pins `sm` buttons to one line.
        className="h-auto! max-w-full whitespace-normal py-1.5 text-center"
      >
        {t('hub:liteRtLm.prepareAccelerator')}
      </Button>
    )
  }
  if (verdict.verdict !== 'ok') return null
  return <DownloadButton fields={fields} variant={variant} token={token} />
}

function DownloadButton({
  fields,
  variant,
  token,
}: {
  fields: LiteRtLmHubModel
  variant: LiteRtLmHubVariant
  /** The person's Hugging Face token; a gated repository waits for it. */
  token: string | undefined
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const downloadId = liteRtLmDownloadId(variant.id)
  const transfer = useDownloadStore((state) => state.downloads[downloadId]?.progress)
  const isDownloading = useDownloadStore(
    (state) => state.localDownloadingModels.has(downloadId) || downloadId in state.downloads
  )
  // From the click until the variant is listed. The download panel drops its row and the
  // in-progress mark when the files are in, while `model.yml` is still written and the list read
  // again (a second): without this the card offered Download again in between.
  const [installing, setInstalling] = useState(false)
  const busy = isDownloading || installing
  // Past the transfer there is no row: what is left is the finishing step.
  const progress = transfer ?? (installing && !isDownloading ? 1 : 0)
  const [failure, setFailure] = useState<string | null>(null)

  const download = useCallback(async () => {
    const store = useDownloadStore.getState()
    setInstalling(true)
    setFailure(null)
    store.clearResumableDownload(downloadId)
    // The download panel names the row after this, not after the id.
    store.setDownloadOrigin(downloadId, `${fields.name} (${variantLabel(variant)})`)
    store.addLocalDownloadingModel(downloadId)
    try {
      await installLiteRtLmVariant({ model: fields, variant, ...(token ? { hfToken: token } : {}) })
      // A variant is a model once `model.yml` is written: list it, so the card offers a chat.
      useModelProvider.getState().setProviders(await serviceHub.providers().getProviders())
    } catch (error) {
      // A cancel is the person's own doing, not a failure to report.
      if (!wasDownloadCancellationRequested(downloadId) && !isDownloadCancellationError(error)) {
        setFailure(
          error instanceof GatedModelError
            ? t('hub:liteRtLm.gated', { url: error.url })
            : error instanceof Error
              ? error.message
              : String(error)
        )
      }
    } finally {
      useDownloadStore.getState().removeLocalDownloadingModel(downloadId)
      setInstalling(false)
    }
  }, [downloadId, fields, variant, serviceHub, token, t])

  return (
    <div className="flex w-full flex-col items-end gap-2">
      {busy ? (
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
        <Button size="sm" disabled={fields.gated && !token} onClick={() => void download()}>
          {t('hub:download')}
        </Button>
      )}
      {failure && <p className="text-right text-xs text-destructive">{failure}</p>}
    </div>
  )
}

/**
 * The card's action column: one width whatever the chosen variant offers (Download, New chat, the
 * provider page), and a slot for the trash that is there even when empty, so the main button keeps
 * its place when another variant is chosen. Sized by content, the column resized the variant list
 * on every pick, and without the slot the button jumped by the trash's width.
 */
function ActionColumn({
  children,
  trash,
  className,
}: {
  children: ReactNode
  trash: ReactNode
  className?: string
}) {
  return (
    <div
      data-testid="litert-lm-actions"
      className={cn('flex w-44 shrink-0 items-start justify-end gap-1', className)}
    >
      <div data-testid="litert-lm-main-action" className="flex min-w-0 justify-end">
        {children}
      </div>
      <div className="size-8 shrink-0">{trash}</div>
    </div>
  )
}

/** "New chat" on `litert-lm` with the variant; the delete sits in the column's trash slot. */
function NewChatButton({ modelId }: { modelId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()

  const newChat = useCallback(() => {
    useModelProvider.getState().selectModelProvider(PROVIDER, modelId)
    switchToModel({ modelId, providerName: PROVIDER, serviceHub }).catch((error) => {
      console.error('[LiteRtLmDownloadOptions] switchToModel failed:', error)
    })
    navigate({
      to: route.home,
      params: {},
      search: { threadModel: { id: modelId, provider: PROVIDER } },
    })
  }, [modelId, navigate, serviceHub])

  return (
    <Button size="sm" onClick={newChat}>
      {t('hub:newChat')}
    </Button>
  )
}
