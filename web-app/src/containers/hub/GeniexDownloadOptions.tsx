import { useNavigate } from '@tanstack/react-router'
import { IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { DeleteModelAction } from '@/containers/hub/DeleteModelAction'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useGeniexChip } from '@/hooks/useGeniexHub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  cancelDownload,
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import { geniexDownloadId } from '@/lib/geniex/download-id'
import { geniexOf, pickDefaultGeniexDevice, variantForChip } from '@/lib/geniex/hub'
import { cn, formatBytes } from '@/lib/utils'
import { checkGeniexModel } from '@/services/geniex/core'
import { installGeniexModel } from '@/services/geniex/install'
import type {
  GeniexCheckResult,
  GeniexChip,
  GeniexDevice,
  GeniexHubModel,
} from '@/services/geniex/types'
import { GatedModelError } from '@/services/managed-models/models'
import type { CatalogModel } from '@/services/models/types'
import { switchToModel } from '@/utils/switchModel'

const PROVIDER = 'geniex'

type Verdict = GeniexCheckResult | { error: string }
type Verdicts = Record<string, Verdict>

const verdictOf = (verdicts: Verdicts, key: string): string | undefined => {
  const entry = verdicts[key]
  return entry && 'verdict' in entry ? entry.verdict : undefined
}

const messageOf = (error: unknown) =>
  (error as { message?: unknown } | null)?.message
    ? String((error as { message: unknown }).message)
    : String(error)

/**
 * The download part of a GenieX card (change `add-geniex-runtime`, spec `geniex-desktop` "Model
 * Hub предлагает модели GenieX на двух полках", spec `geniex-models` "Устройство по умолчанию
 * выбирается под железо"):
 *
 * - a GGUF model: its devices, each with the core's verdict, one chosen by default — NPU, then
 *   GPU, then CPU among those that run here — and `hybrid` as a choice of the person's own;
 * - an AI Hub bundle: the one variant compiled for this computer's chip, with its precision,
 *   context length and the core's verdict; no other chip's bundle is shown.
 *
 * The action for what is chosen: "Download" when the core says it runs (`ok`), through the
 * installer under one row of the download panel; "Install GenieX" when the SDK is missing, leading
 * to the provider page rather than downloading a model that cannot run; "New chat" and delete once
 * the model is on disk. A gated repository without the person's Hugging Face token says what to do
 * and downloads nothing until the token is there. A Hugging Face model says it is not verified.
 */
export function GeniexDownloadOptions({
  model,
  sectionRef,
  chip: chipProp,
}: {
  model: CatalogModel
  sectionRef?: RefObject<HTMLElement | null>
  /** This computer's chip; read from the core's accelerators answer when not given. */
  chip?: GeniexChip | null
}) {
  const fields = geniexOf(model) as GeniexHubModel
  const readChip = useGeniexChip(chipProp === undefined)
  const chip = chipProp === undefined ? readChip : chipProp

  const providers = useModelProvider((state) => state.providers)
  const downloadedIds = useMemo(
    () =>
      new Set(
        providers.find((provider) => provider.provider === PROVIDER)?.models.map((entry) => entry.id) ?? []
      ),
    [providers]
  )

  // A model found on disk in "Downloaded": nothing to choose or check, only chat and delete.
  if (fields.origin === 'installed') {
    return (
      <Section sectionRef={sectionRef}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{fields.name}</span>
          <ActionColumn trash={<DeleteModelAction modelId={fields.model_id} provider={PROVIDER} />}>
            <NewChatButton modelId={fields.model_id} />
          </ActionColumn>
        </div>
      </Section>
    )
  }

  if (fields.kind === 'qairt') {
    return <BundleOptions fields={fields} chip={chip} downloadedIds={downloadedIds} sectionRef={sectionRef} />
  }
  return <GgufOptions fields={fields} downloadedIds={downloadedIds} sectionRef={sectionRef} />
}

function Section({ sectionRef, children }: { sectionRef?: RefObject<HTMLElement | null>; children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <section ref={sectionRef} className="scroll-mt-4 rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
      {children}
    </section>
  )
}

// ── A GGUF model: devices ──────────────────────────────────────────────────

function GgufOptions({
  fields,
  downloadedIds,
  sectionRef,
}: {
  fields: GeniexHubModel
  downloadedIds: ReadonlySet<string>
  sectionRef?: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const gguf = fields.gguf
  const token = useGeneralSetting((state) => state.huggingfaceToken)
  const needsToken = !!gguf?.gated && !token
  const devices = useMemo(() => gguf?.devices ?? [], [gguf])
  const [verdicts, setVerdicts] = useState<Verdicts>({})
  const [picked, setPicked] = useState<GeniexDevice | null>(null)

  useEffect(() => {
    let cancelled = false
    setVerdicts({})
    setPicked(null)
    void Promise.all(
      devices.map(async (device) => {
        try {
          return [device, await checkGeniexModel({ plugin: 'llama_cpp', device })] as const
        } catch (error) {
          return [device, { error: messageOf(error) }] as const
        }
      })
    ).then((entries) => {
      if (!cancelled) setVerdicts(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [devices])

  const downloaded = downloadedIds.has(fields.model_id)
  const selected =
    (picked && devices.includes(picked) ? picked : undefined) ??
    pickDefaultGeniexDevice(devices, (device) => verdictOf(verdicts, device)) ??
    devices[0]
  const sizeBytes = gguf ? gguf.file.size + (gguf.mmproj?.size ?? 0) : 0

  return (
    <Section sectionRef={sectionRef}>
      {fields.origin === 'huggingface' && (
        <p className="mb-3 text-xs text-muted-foreground">{t('hub:geniex.notVerified')}</p>
      )}
      {needsToken && gguf && <GatedNotice repo={gguf.repo} />}
      {!gguf || devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('hub:geniex.noDeviceHere')}</p>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div role="radiogroup" className="flex min-w-0 flex-1 flex-col gap-1">
            {devices.map((device) => {
              const checked = selected === device
              return (
                <button
                  key={device}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={t(`hub:geniex.device.${device}`)}
                  onClick={() => setPicked(device)}
                  className={cn(
                    'flex w-full min-w-0 flex-col items-start rounded-md border border-transparent px-2 py-1.5 text-left hover:bg-accent',
                    checked && 'border-border bg-accent'
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{t(`hub:geniex.device.${device}`)}</span>
                    <span className="text-xs text-muted-foreground">{formatBytes(sizeBytes)}</span>
                  </span>
                  <VerdictLine entry={verdicts[device]} downloaded={downloaded} />
                </button>
              )
            })}
          </div>
          {selected && (
            <ActionColumn
              className="pt-[max(0px,calc(1px_+_0.375rem_+_var(--text-sm)_*_0.625_/_0.875_-_1rem))]"
              trash={downloaded ? <DeleteModelAction modelId={fields.model_id} provider={PROVIDER} /> : null}
            >
              <Action
                key={selected}
                modelId={fields.model_id}
                downloaded={downloaded}
                verdict={verdicts[selected]}
                rowName={`${fields.name} (${t(`hub:geniex.device.${selected}`)})`}
                gated={needsToken}
                install={() =>
                  installGeniexModel({ model: fields, device: selected, ...(token ? { hfToken: token } : {}) })
                }
              />
            </ActionColumn>
          )}
        </div>
      )}
    </Section>
  )
}

// ── An AI Hub bundle: this chip's variant ──────────────────────────────────

function BundleOptions({
  fields,
  chip,
  downloadedIds,
  sectionRef,
}: {
  fields: GeniexHubModel
  chip: GeniexChip | null
  downloadedIds: ReadonlySet<string>
  sectionRef?: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const variant = useMemo(() => variantForChip(fields.variants ?? [], chip), [fields, chip])
  const [verdict, setVerdict] = useState<Verdict | undefined>(undefined)

  useEffect(() => {
    if (!variant) return
    let cancelled = false
    setVerdict(undefined)
    void checkGeniexModel({
      plugin: 'qairt',
      device: 'npu',
      chip: variant.chip,
      ...(variant.min_runtime_version ? { min_runtime_version: variant.min_runtime_version } : {}),
    })
      .then((answer) => {
        if (!cancelled) setVerdict(answer)
      })
      .catch((error: unknown) => {
        if (!cancelled) setVerdict({ error: messageOf(error) })
      })
    return () => {
      cancelled = true
    }
  }, [variant])

  if (!variant) {
    return (
      <Section sectionRef={sectionRef}>
        <p className="text-sm text-muted-foreground">{t('hub:geniex.noBundleHere')}</p>
      </Section>
    )
  }
  const downloaded = downloadedIds.has(variant.id)
  return (
    <Section sectionRef={sectionRef}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5">
          <span className="flex w-full items-center justify-between gap-2 text-sm">
            <span className="font-medium">
              {t('hub:geniex.bundle.chip', { chip: t(`hub:geniex.chipLabel.${variant.chip}`) })}
            </span>
            <span className="text-xs text-muted-foreground">{formatBytes(variant.bundle.size)}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            {t('hub:geniex.bundle.precision', { precision: variant.precision })}
          </span>
          {fields.context_length !== undefined && (
            <span className="text-xs text-muted-foreground">
              {t('hub:geniex.bundle.context', { context: fields.context_length })}
            </span>
          )}
          <VerdictLine entry={verdict} downloaded={downloaded} />
        </div>
        <ActionColumn trash={downloaded ? <DeleteModelAction modelId={variant.id} provider={PROVIDER} /> : null}>
          <Action
            key={variant.id}
            modelId={variant.id}
            downloaded={downloaded}
            verdict={verdict}
            rowName={`${fields.name} (${t(`hub:geniex.chipLabel.${variant.chip}`)})`}
            gated={false}
            install={() => installGeniexModel({ model: fields, variant })}
          />
        </ActionColumn>
      </div>
    </Section>
  )
}

// ── Shared pieces ──────────────────────────────────────────────────────────

/** A gated repository without a token: what to accept where, and the way to the token setting. */
function GatedNotice({ repo }: { repo: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const url = `https://huggingface.co/${repo}`
  return (
    <div className="mb-3 flex flex-col items-start gap-2 rounded-md border border-border p-3 text-xs">
      <p>{t('hub:geniex.gatedNoToken')}</p>
      <a className="break-all underline" href={url} target="_blank" rel="noreferrer">
        {repo}
      </a>
      <Button size="sm" variant="outline" onClick={() => navigate({ to: route.settings.general })}>
        {t('hub:geniex.setToken')}
      </Button>
    </div>
  )
}

function VerdictLine({ entry, downloaded }: { entry: Verdict | undefined; downloaded: boolean }) {
  const { t } = useTranslation()
  const text = downloaded
    ? t('hub:geniex.downloaded')
    : !entry
      ? t('hub:geniex.checking')
      : 'error' in entry
        ? entry.error
        : entry.verdict === 'ok'
          ? t('hub:geniex.runsHere')
          : (entry.reason ?? entry.verdict)
  return <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{text}</span>
}

function Action({
  modelId,
  downloaded,
  verdict,
  rowName,
  gated,
  install,
}: {
  modelId: string
  downloaded: boolean
  verdict: Verdict | undefined
  /** What the download panel names the row. */
  rowName: string
  /** The repository is gated and no token is set: Download waits. */
  gated: boolean
  install: () => Promise<unknown>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  if (downloaded) return <NewChatButton modelId={modelId} />
  if (!verdict || 'error' in verdict) return null
  if (verdict.verdict === 'engine-not-installed') {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => navigate({ to: route.settings.providers, params: { providerName: PROVIDER } })}
        // The column is fixed; a long label wraps inside it rather than spilling over the list.
        // `h-auto!`: the shell's control-height rule in index.css pins `sm` buttons to one line.
        className="h-auto! max-w-full whitespace-normal py-1.5 text-center"
      >
        {t('hub:geniex.installEngine')}
      </Button>
    )
  }
  if (verdict.verdict !== 'ok') return null
  return <DownloadButton modelId={modelId} rowName={rowName} gated={gated} install={install} />
}

function DownloadButton({
  modelId,
  rowName,
  gated,
  install,
}: {
  modelId: string
  rowName: string
  gated: boolean
  install: () => Promise<unknown>
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const downloadId = geniexDownloadId(modelId)
  const transfer = useDownloadStore((state) => state.downloads[downloadId]?.progress)
  const isDownloading = useDownloadStore(
    (state) => state.localDownloadingModels.has(downloadId) || downloadId in state.downloads
  )
  // From the click until the model is listed: the panel drops its row when the files are in,
  // while the core's check and `model.yml` are still on their way (a second or two).
  const [installing, setInstalling] = useState(false)
  const busy = isDownloading || installing
  const progress = transfer ?? (installing && !isDownloading ? 1 : 0)
  const [failure, setFailure] = useState<string | null>(null)

  const download = useCallback(async () => {
    const store = useDownloadStore.getState()
    setInstalling(true)
    setFailure(null)
    store.clearResumableDownload(downloadId)
    // The download panel names the row after this, not after the id.
    store.setDownloadOrigin(downloadId, rowName)
    store.addLocalDownloadingModel(downloadId)
    try {
      await install()
      // A model is one once `model.yml` is written: list it, so the card offers a chat.
      useModelProvider.getState().setProviders(await serviceHub.providers().getProviders())
    } catch (error) {
      // A cancel is the person's own doing, not a failure to report.
      if (!wasDownloadCancellationRequested(downloadId) && !isDownloadCancellationError(error)) {
        // The relay (`atomic_core_call`) rejects with `{code, message}`, not an Error: its words, not "[object Object]".
        setFailure(error instanceof GatedModelError ? t('hub:geniex.gated', { url: error.url }) : messageOf(error))
      }
    } finally {
      useDownloadStore.getState().removeLocalDownloadingModel(downloadId)
      setInstalling(false)
    }
  }, [downloadId, install, rowName, serviceHub, t])

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
        <Button size="sm" disabled={gated} onClick={() => void download()}>
          {t('hub:download')}
        </Button>
      )}
      {failure && <p className="text-right text-xs text-destructive">{failure}</p>}
    </div>
  )
}

/**
 * The card's action column: one width whatever the choice offers (Download, New chat, the provider
 * page), and a slot for the trash that is there even when empty, so the main button keeps its
 * place when another device is chosen.
 */
function ActionColumn({ children, trash, className }: { children: ReactNode; trash: ReactNode; className?: string }) {
  return (
    <div data-testid="geniex-actions" className={cn('flex w-44 shrink-0 items-start justify-end gap-1', className)}>
      <div data-testid="geniex-main-action" className="flex min-w-0 justify-end">
        {children}
      </div>
      <div className="size-8 shrink-0">{trash}</div>
    </div>
  )
}

/** "New chat" on `geniex` with the model; the delete sits in the column's trash slot. */
function NewChatButton({ modelId }: { modelId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()

  const newChat = useCallback(() => {
    useModelProvider.getState().selectModelProvider(PROVIDER, modelId)
    switchToModel({ modelId, providerName: PROVIDER, serviceHub }).catch((error) => {
      console.error('[GeniexDownloadOptions] switchToModel failed:', error)
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

