import { useModelProvider } from '@/hooks/useModelProvider'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { localStorageKey } from '@/constants/localStorage'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useMemo, useCallback, useRef } from 'react'
import { AppEvent, events } from '@janhq/core'
import type { CatalogModel, ModelQuant } from '@/services/models/types'
import { DEFAULT_MODEL_QUANTIZATIONS } from '@/constants/models'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn, sanitizeModelId } from '@/lib/utils'
import { extractModelName } from '@/lib/models'
import { useResolvedRecommendedModels } from '@/hooks/useResolvedRecommendedModels'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import HeaderPage from './HeaderPage'
import { useModelSources } from '@/hooks/useModelSources'
import { useShallow } from 'zustand/shallow'
import { HuggingFaceAuthorAvatar } from '@/components/HuggingFaceAuthorAvatar'

//* Вариант загрузки: приоритет квантов как в Hub
function pickPreferredVariant(model: CatalogModel): ModelQuant | null {
  const preferred =
    model.quants?.find((m) =>
      DEFAULT_MODEL_QUANTIZATIONS.some((e) =>
        m.model_id.toLowerCase().includes(e)
      )
    ) ?? null
  return preferred ?? model.quants?.[0] ?? null
}

//* ГБ для строки прогресса (как в DownloadManagement)
function formatDownloadGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2)
}

//* Иконка бренда по id репозитория HF (public/svg)
function recommendedSetupModelIconSrc(hfRepoId: string): string | null {
  const id = hfRepoId.toLowerCase()
  //? Distill-Qwen в названии DeepSeek — сначала deepseek, иначе попадём в Qwen
  if (id.includes('deepseek')) return '/svg/deepseek-color.svg'
  if (id.includes('qwen')) return '/svg/qwen-color.svg'
  if (id.includes('llama') || id.includes('meta-llama'))
    return '/svg/meta-color.svg'
  return null
}

type SetupScreenProps = {
  onSkipped?: () => void
}

function SetupScreen({ onSkipped }: SetupScreenProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { getProviderByName, selectModelProvider, setProviders } =
    useModelProvider()

  const { downloads, localDownloadingModels, addLocalDownloadingModel } =
    useDownloadStore()
  const serviceHub = useServiceHub()
  const llamaProvider = getProviderByName('llamacpp')
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)

  const {
    sources,
    fetchSources,
    loading: sourcesLoading,
  } = useModelSources(
    useShallow((state) => ({
      sources: state.sources,
      fetchSources: state.fetchSources,
      loading: state.loading,
    }))
  )

  const trackedImportIdsRef = useRef<Set<string>>(new Set())
  const hasNavigatedRef = useRef(false)

  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  const recommendedItems = useResolvedRecommendedModels(sources)

  const downloadProcesses = useMemo(
    () =>
      Object.values(downloads).map((download) => ({
        id: download.name,
        name: download.name,
        progress: download.progress,
        current: download.current,
        total: download.total,
      })),
    [downloads]
  )

  const isVariantDownloading = useCallback(
    (variantId: string) =>
      localDownloadingModels.has(variantId) ||
      downloadProcesses.some((e) => e.id === variantId),
    [localDownloadingModels, downloadProcesses]
  )

  const isVariantDownloaded = useCallback(
    (catalog: CatalogModel, variant: ModelQuant) =>
      llamaProvider?.models.some(
        (m: { id: string }) =>
          m.id === variant.model_id ||
          m.id === `${catalog.developer}/${sanitizeModelId(variant.model_id)}`
      ) ?? false,
    [llamaProvider]
  )

  const anyDownloading = useMemo(() => {
    for (const { model } of recommendedItems) {
      if (!model) continue
      const v = pickPreferredVariant(model)
      if (v && isVariantDownloading(v.model_id)) return true
    }
    return false
  }, [recommendedItems, isVariantDownloading])

  const startDownload = useCallback(
    (catalog: CatalogModel, variant: ModelQuant) => {
      trackedImportIdsRef.current.add(variant.model_id)
      addLocalDownloadingModel(variant.model_id)
      serviceHub
        .models()
        .pullModelWithMetadata(
          variant.model_id,
          variant.path,
          (
            catalog.mmproj_models?.find(
              (e) => e.model_id.toLowerCase() === 'mmproj-f16'
            ) || catalog.mmproj_models?.[0]
          )?.path,
          huggingfaceToken,
          true
        )
    },
    [addLocalDownloadingModel, serviceHub, huggingfaceToken]
  )

  useEffect(() => {
    const onModelImported = async (payload: { modelId: string }) => {
      if (hasNavigatedRef.current) return
      if (!trackedImportIdsRef.current.has(payload.modelId)) return

      hasNavigatedRef.current = true
      trackedImportIdsRef.current.delete(payload.modelId)

      const providers = await serviceHub.providers().getProviders()
      setProviders(providers)

      const catalogId = payload.modelId
      const backslashId = catalogId.replace(/\//g, '\\')
      const found =
        selectModelProvider('llamacpp', catalogId) ||
        selectModelProvider('llamacpp', backslashId)
      const modelId = found ? found.id : catalogId

      toast.dismiss(`model-validation-started-${catalogId}`)
      localStorage.setItem(localStorageKey.setupCompleted, 'true')
      localStorage.setItem(
        localStorageKey.lastUsedModel,
        JSON.stringify({ provider: 'llamacpp', model: modelId })
      )
      navigate({
        to: route.home,
        replace: true,
        search: {
          threadModel: { id: modelId, provider: 'llamacpp' },
        },
      })
    }

    events.on(AppEvent.onModelImported, onModelImported)

    return () => {
      events.off(AppEvent.onModelImported, onModelImported)
    }
  }, [navigate, selectModelProvider, serviceHub, setProviders])

  const handleSkip = useCallback(() => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    localStorage.removeItem(localStorageKey.lastUsedModel)
    onSkipped?.()
    void navigate({
      to: route.home,
      replace: true,
      search: {},
    })
  }, [navigate, onSkipped])

  return (
    <div className="relative flex h-svh w-full flex-col overflow-hidden">
      <div className="flex h-svh min-h-0 w-full flex-col">
        <HeaderPage />

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="pointer-events-auto mx-auto flex min-h-0 w-full max-w-[840px] flex-1 flex-col px-6 pb-4 pt-2 sm:px-10">
            <div className="mb-4 shrink-0 text-center sm:mb-5">
              {!anyDownloading && (
                <div className="mb-5 flex items-center justify-center gap-3 font-studio text-5xl font-semibold leading-none tracking-tight sm:text-6xl">
                  <div className="flex h-[1em] w-[1em] shrink-0 items-center justify-center rounded-lg bg-neutral-950 p-[3px] shadow-sm dark:bg-white dark:shadow-none">
                    <img
                      src="/images/transparent-logo.png"
                      alt=""
                      className="size-full min-h-0 min-w-0 object-contain invert dark:invert-0"
                      draggable={false}
                    />
                  </div>
                  <span>Atomic Chat</span>
                </div>
              )}
              <h1
                className={cn(
                  'font-studio mb-3 font-bold leading-none tracking-tight',
                  anyDownloading
                    ? 'text-4xl sm:text-5xl'
                    : 'text-3xl sm:text-4xl md:text-[2.5rem]'
                )}
              >
                {anyDownloading && 'Sit tight, Atomic Chat is getting ready...'}
              </h1>
              {!anyDownloading && (
                <div className="mb-3 min-w-0">
                  <span className="inline-block text-lg font-bold leading-snug sm:text-xl md:text-2xl">
                    No rate limits. No subscriptions. No cloud.
                  </span>
                </div>
              )}
              <p
                className={cn(
                  'text-muted-foreground mx-auto max-w-full text-pretty leading-relaxed text-base sm:text-lg'
                )}
              >
                {anyDownloading
                  ? 'This may take a few minutes.'
                  : t('setup:turboQuantTagline')}
              </p>
            </div>

            <div className="relative z-50 flex min-h-0 flex-1 flex-col justify-start gap-2">
              <div className="flex flex-col gap-2">
                <span className="shrink-0 text-left text-xs font-medium text-muted-foreground">
                  {t('hub:recTitle')}
                </span>
                <div
                  className={cn(
                    'w-full shrink-0 rounded-lg border bg-secondary/50 p-3 sm:p-4',
                    //* Высота по контенту; при длинном списке — скролл, без flex-1 на весь экран
                    'max-h-[min(70vh,36rem)] overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]'
                  )}
                >
                  <div className="flex flex-col divide-y divide-border/60">
                    {recommendedItems.map(({ rec, model }) => {
                      const variant = model ? pickPreferredVariant(model) : null
                      const rowDownloading = variant
                        ? isVariantDownloading(variant.model_id)
                        : false
                      const rowDownloaded =
                        model && variant
                          ? isVariantDownloaded(model, variant)
                          : false
                      const hfAuthor =
                        model?.developer?.trim() ||
                        rec.modelName.split('/')[0]?.trim() ||
                        ''
                      const nameForInitials =
                        extractModelName(rec.modelName) || rec.modelName || '?'
                      const rowInitials =
                        nameForInitials
                          .replace(/\.(gguf|GGUF)$/i, '')
                          .replace(/[^a-zA-Z0-9]/g, '')
                          .slice(0, 2) ||
                        hfAuthor.slice(0, 2) ||
                        '?'

                      const brandIconSrc = recommendedSetupModelIconSrc(
                        rec.modelName
                      )
                      const rowDownloadProgress = variant
                        ? downloadProcesses.find(
                            (p) => p.id === variant.model_id
                          )
                        : undefined

                      return (
                        <div
                          key={`${rec.modelName}-${rec.descriptionKey}`}
                          className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                        >
                          <div className="flex min-w-0 flex-1 items-start gap-3">
                            {brandIconSrc ? (
                              <img
                                src={brandIconSrc}
                                alt=""
                                className="size-11 shrink-0 object-contain sm:size-12"
                                draggable={false}
                                aria-hidden
                              />
                            ) : (
                              <HuggingFaceAuthorAvatar
                                author={hfAuthor}
                                initials={rowInitials}
                                className="size-11 shrink-0 sm:size-12"
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <h2 className="font-semibold text-sm leading-tight sm:text-base sm:whitespace-nowrap">
                                {model
                                  ? extractModelName(model.model_name)
                                  : extractModelName(rec.modelName)}
                                {variant?.file_size ? (
                                  <span className="text-xs font-normal text-muted-foreground">
                                    {' '}
                                    · {variant.file_size}
                                  </span>
                                ) : null}
                              </h2>
                              <span
                                className="mt-1.5 inline-block max-w-full truncate rounded-full bg-black/90 px-2.5 py-0.5 text-xs font-semibold text-white shadow-sm dark:bg-white/90 dark:text-black sm:max-w-md"
                                title={t(rec.descriptionKey)}
                              >
                                {t(rec.descriptionKey)}
                              </span>
                              {!model && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {sourcesLoading
                                    ? t('hub:loadingModels')
                                    : t('setup:modelUnavailable')}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex w-full flex-col items-center gap-1 sm:w-auto sm:shrink-0">
                            <Button
                              size="sm"
                              disabled={
                                !model ||
                                !variant ||
                                rowDownloading ||
                                rowDownloaded
                              }
                              onClick={() =>
                                model &&
                                variant &&
                                startDownload(model, variant)
                              }
                              className="w-full shrink-0 rounded-full px-5 font-semibold sm:w-auto"
                            >
                              {rowDownloaded
                                ? t('hub:downloaded')
                                : rowDownloading
                                  ? t('setup:downloading')
                                  : t('hub:download')}
                            </Button>
                            {rowDownloading && variant ? (
                              <p
                                className="w-full text-center text-xs text-muted-foreground tabular-nums sm:w-auto sm:max-w-full"
                                aria-live="polite"
                              >
                                {rowDownloadProgress &&
                                rowDownloadProgress.total > 0
                                  ? `${Math.round((rowDownloadProgress.progress ?? 0) * 100)}% · ${formatDownloadGb(rowDownloadProgress.current)} / ${formatDownloadGb(rowDownloadProgress.total)} GB`
                                  : t('setup:downloadPreparing')}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="relative z-60 flex shrink-0 flex-col items-center pt-3">
                  <Button
                    type="button"
                    variant="link"
                    onClick={handleSkip}
                    className="text-muted-foreground/60 hover:text-muted-foreground relative z-60 h-auto p-0 text-xs font-normal underline-offset-4"
                  >
                    {t('setup:skip')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SetupScreen
