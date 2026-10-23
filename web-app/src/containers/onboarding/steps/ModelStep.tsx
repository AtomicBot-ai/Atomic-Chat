import { useEffect, useMemo, useRef, useState } from 'react'
import { EngineManager } from '@janhq/core'
import { ArrowRight, Check, Laptop, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { modelSourceLabel } from '@/components/ModelSourceBadge'
import { ConfirmWontFitDownload } from '@/containers/ConfirmWontFitDownload'
import { FamilyLogoMark } from '@/containers/ModelLogo'
import { fitLabelKey } from '@/containers/SetupScreenHelpers'
import { useConfirmWontFitDownload } from '@/hooks/useConfirmWontFitDownload'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { estimatedMemoryGb } from '@/lib/model-card'
import { HUGGINGFACE_LOGO_SRC } from '@/lib/model-logo'
import {
  buildRecommendedImpressions,
  captureRecommendedModelClicked,
  captureRecommendedModelsShown,
  captureSetupLocalModelRun,
  captureSetupScreenShown,
} from '@/lib/onboarding-telemetry'
import {
  importCandidatesInBackground,
  providerForCandidate,
  startGgufCatalogDownload,
  startMlxCatalogDownload,
} from '@/lib/onboarding/downloads'
import { useModelProvider } from '@/hooks/useModelProvider'
import { cn } from '@/lib/utils'
import { useOnboardingStore } from '@/stores/onboarding-store'

import {
  useModelOptions,
  type DownloadOption,
  type ModelOption,
} from '../useModelOptions'
import type { StepProps } from './types'

/** Paths already handed to an engine this session, so none goes twice. */
const importedPaths = new Set<string>()

const GB = 1024 ** 3

function OptionIcon({ option }: { option: ModelOption }) {
  const src =
    option.iconSrc ??
    (option.kind === 'download' && option.source === 'huggingface'
      ? HUGGINGFACE_LOGO_SRC
      : null)
  if (src) return <FamilyLogoMark src={src} className="ob-model-logo" />
  return option.kind === 'download' ? (
    <Sparkles size={20} aria-hidden="true" />
  ) : (
    <Laptop size={20} aria-hidden="true" />
  )
}

/**
 * "Choose your first model": what is already on this machine first, then
 * the offer for its tier and two curated picks it can run, then Hugging
 * Face's most downloaded chat models — every row with a line on what it is
 * good for. The list scrolls under a bar that names the choice; Continue
 * starts the download — it carries on through the next steps — or takes the
 * model already here.
 */
export function ModelStep({ next }: StepProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const options = useModelOptions()
  const { guardWontFit, confirmation } = useConfirmWontFitDownload()
  const choice = useOnboardingStore((state) => state.choice)
  const all = useMemo(
    () => [...options.onDevice, ...options.recommended, ...options.huggingFace],
    [options.onDevice, options.recommended, options.huggingFace]
  )

  // What is on the machine is preselected; otherwise the best fit is.
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const chosenKey = choice
    ? all.find((option) =>
        option.matchIds.some((id) => choice.matchIds.includes(id))
      )?.key
    : undefined
  const selected =
    all.find((option) => option.key === (pickedKey ?? chosenKey)) ?? all[0]

  // Detected models land in the library whichever way the step is left.
  const detectedRef = useRef(options.detected)
  detectedRef.current = options.detected
  useEffect(
    () => () => {
      const rest = detectedRef.current
        .flatMap((option) => (option.kind === 'scan' ? [option.candidate] : []))
        .filter((candidate) => !importedPaths.has(candidate.path))
      rest.forEach((candidate) => importedPaths.add(candidate.path))
      importCandidatesInBackground(rest, {
        serviceHub,
        onProviders: useModelProvider.getState().setProviders,
      })
    },
    [serviceHub]
  )

  // `setup_screen_shown` once the list is settled, then an impression per
  // row, as the old screen reported them, so the funnel keeps its series.
  const shownRef = useRef(false)
  const impressionsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!options.ready) return
    if (!shownRef.current) {
      if (options.recommended.length === 0 && options.catalogLoading) return
      shownRef.current = true
      captureSetupScreenShown({
        recommendedCount: options.recommended.length,
        rendered: true,
        hardwareTier: options.tier,
        hardwareTierResolved: options.tierReady,
        memoryKind: options.profile?.memoryKind ?? null,
        memoryBudgetMib: options.profile?.budgetMib ?? null,
        primaryModelId: options.recommended[0]?.taskId ?? null,
        detectedLocalModelsCount: options.detected.length,
        detectedSources: [
          ...new Set(
            options.detected.flatMap((option) =>
              option.kind === 'scan' ? [option.candidate.source] : []
            )
          ),
        ],
      })
    }
    const fresh = buildRecommendedImpressions({
      pending: options.recommended.map((option) => ({
        startId: option.taskId,
        model: option.catalog,
      })),
      installed: options.library.flatMap((option) =>
        option.kind === 'library'
          ? [{ startId: option.modelId, provider: option.provider }]
          : []
      ),
      detected: options.detected.flatMap((option) =>
        option.kind === 'scan'
          ? [{ id: option.candidate.id, format: option.candidate.format }]
          : []
      ),
    }).filter((item) => {
      const key = `${item.section}:${item.modelId}:${item.position}`
      if (impressionsRef.current.has(key)) return false
      impressionsRef.current.add(key)
      return true
    })
    if (fresh.length > 0) captureRecommendedModelsShown(fresh)
  }, [options])

  const startDownload = (option: DownloadOption) => {
    const store = useOnboardingStore.getState()
    const huggingfaceToken = useGeneralSetting.getState().huggingfaceToken
    captureRecommendedModelClicked({
      modelId: option.taskId,
      format: option.isMlx ? 'MLX' : 'GGUF',
      sizeGb: option.sizeBytes
        ? Math.round((option.sizeBytes / GB) * 100) / 100
        : undefined,
      position: option.position,
    })
    store.enqueue({
      key: 'chat',
      kind: 'chat',
      title: option.title,
      taskId: option.taskId,
      totalBytes: option.sizeBytes,
      phase: 'running',
    })
    if (option.isMlx) {
      void startMlxCatalogDownload(option.catalog, {
        serviceHub,
        huggingfaceToken,
        requestOrigin: 'onboarding',
      }).then((imported) =>
        useOnboardingStore
          .getState()
          .setJobPhase('chat', imported ? 'done' : 'failed')
      )
    } else if (option.variant) {
      startGgufCatalogDownload(
        option.catalog,
        option.variant,
        option.mmprojPath,
        {
          serviceHub,
          huggingfaceToken,
          requestOrigin: 'onboarding',
          onRefused: () =>
            useOnboardingStore.getState().setJobPhase('chat', 'failed'),
        }
      )
    }
  }

  const takeLocal = (option: Exclude<ModelOption, DownloadOption>) => {
    if (option.kind === 'scan') {
      const { candidate } = option
      const engine = EngineManager.instance().get(
        providerForCandidate(candidate)
      )
      if (!engine) {
        toast.error(t('setup:localStep.importFailed'))
        return false
      }
      importedPaths.add(candidate.path)
      void engine
        .import(candidate.id, {
          modelPath: candidate.path,
          mmprojPath: candidate.mmprojPath,
          source: candidate.source,
        })
        .catch((error: unknown) => {
          console.error('[onboarding] import failed', error)
          toast.error(t('setup:localStep.importFailed'))
          useOnboardingStore.getState().choose(null)
        })
      captureSetupLocalModelRun({
        trigger: 'manual',
        scanSource: candidate.source,
        format: candidate.format,
        sizeBytes: candidate.sizeBytes ?? null,
        detectedCount: options.detected.length,
      })
    } else {
      captureSetupLocalModelRun({
        trigger: 'installed_recommended',
        providerId: option.provider,
      })
    }
    return true
  }

  const proceed = () => {
    if (!selected) {
      next('no_model')
      return
    }
    const store = useOnboardingStore.getState()
    const alreadyChosen =
      store.choice?.matchIds.some((id) => selected.matchIds.includes(id)) ??
      false
    if (alreadyChosen) {
      next('continue')
      return
    }
    if (selected.kind === 'download') {
      guardWontFit(
        {
          level: selected.fit,
          name: selected.title,
          reason: selected.fit ? t(fitLabelKey(selected.fit)) : null,
        },
        () => {
          startDownload(selected)
          useOnboardingStore.getState().choose({
            source: 'download',
            provider: selected.provider,
            modelId: selected.taskId,
            title: selected.title,
            matchIds: selected.matchIds,
          })
          next('download')
        }
      )
      return
    }
    if (!takeLocal(selected)) return
    store.choose({
      source: selected.kind === 'scan' ? 'scan' : 'library',
      provider: selected.provider,
      modelId:
        selected.kind === 'scan' ? selected.candidate.id : selected.modelId,
      title: selected.title,
      matchIds: selected.matchIds,
    })
    next('use_model')
  }

  const row = (option: ModelOption) => {
    const checked = option.key === selected?.key
    const meta =
      option.kind === 'download' ? (
        option.sizeLabel && (
          <small
            className={cn(
              'ob-model-meta',
              option.fit === 'no' && 'ob-warn-text'
            )}
          >
            {[
              t('onboarding:model.size', { size: option.sizeLabel }),
              estimatedMemoryGb(option.sizeBytes) != null &&
                t('onboarding:model.aboutMemory', {
                  size: estimatedMemoryGb(option.sizeBytes),
                }),
              option.fit === 'no' && t(fitLabelKey(option.fit)),
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        )
      ) : (
        <small className="ob-model-meta">
          <Check size={12} aria-hidden="true" />
          {option.kind === 'scan'
            ? t('onboarding:model.foundIn', {
                source:
                  modelSourceLabel(option.candidate.source) ??
                  option.candidate.source,
              })
            : t('onboarding:model.downloaded')}
        </small>
      )
    return (
      <button
        key={option.key}
        type="button"
        role="radio"
        aria-checked={checked}
        className="ob-model"
        onClick={() => setPickedKey(option.key)}
      >
        <span className="ob-model-icon">
          <OptionIcon option={option} />
        </span>
        <span className="ob-model-text">
          <strong>
            {option.title}
            {option.kind === 'download' && option.source === 'huggingface' && (
              <img
                className="ob-hf-mark"
                src={HUGGINGFACE_LOGO_SRC}
                alt={t('onboarding:model.huggingFace')}
              />
            )}
          </strong>
          <small className="ob-model-tagline">{option.detail}</small>
          {meta}
        </span>
        <i className="ob-radio" aria-hidden="true" />
      </button>
    )
  }

  const section = (id: string, title: React.ReactNode, rows: ModelOption[]) => (
    <section aria-labelledby={id}>
      <h2 className="ob-model-section-title" id={id}>
        {title}
      </h2>
      <div className="ob-model-list" role="radiogroup" aria-labelledby={id}>
        {rows.map(row)}
      </div>
    </section>
  )

  const deviceLine = [
    options.device.memoryGb != null &&
      t('onboarding:model.memory', { size: options.device.memoryGb }),
    options.device.freeGb != null &&
      t('onboarding:model.freeStorage', { size: options.device.freeGb }),
  ]
    .filter(Boolean)
    .join(' · ')

  const continueLabel = !selected
    ? t('onboarding:model.continueWithout')
    : selected.kind === 'download'
      ? t('onboarding:continue')
      : t('onboarding:model.use', { name: selected.title })

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding:model.title')}</h1>
      {(options.device.name || deviceLine) && (
        <div className="ob-device">
          <Laptop size={20} aria-hidden="true" />
          <div>
            {options.device.name && <strong>{options.device.name}</strong>}
            {deviceLine && <span>{deviceLine}</span>}
          </div>
        </div>
      )}
      {!options.ready ? (
        <div className="ob-status" role="status">
          {t('common:loading')}
        </div>
      ) : (
        <>
          <div
            className="ob-model-catalog"
            role="region"
            aria-label={t('onboarding:model.choose')}
            tabIndex={0}
          >
            {options.onDevice.length > 0 &&
              section(
                'ob-on-device',
                t('onboarding:model.onDevice'),
                options.onDevice
              )}
            {options.recommended.length > 0 ? (
              section(
                'ob-recommended',
                t('onboarding:model.recommended'),
                options.recommended
              )
            ) : (
              <section aria-labelledby="ob-recommended">
                <h2 className="ob-model-section-title" id="ob-recommended">
                  {t('onboarding:model.recommended')}
                </h2>
                <p className="ob-note">
                  {options.catalogLoading
                    ? t('common:loading')
                    : t('onboarding:model.noRecommendations')}
                </p>
              </section>
            )}
            {options.huggingFace.length > 0 &&
              section(
                'ob-hugging-face',
                <>
                  <img src={HUGGINGFACE_LOGO_SRC} alt="" />
                  {t('onboarding:model.huggingFace')}
                </>,
                options.huggingFace
              )}
          </div>
          <div className="ob-model-actionbar">
            <div>
              {selected && (
                <>
                  <strong>{selected.title}</strong>
                  <small>
                    {selected.kind !== 'download'
                      ? t('onboarding:model.readyHere')
                      : selected.sizeLabel &&
                        t('onboarding:model.size', {
                          size: selected.sizeLabel,
                        })}
                  </small>
                </>
              )}
            </div>
            <button type="button" className="ob-primary" onClick={proceed}>
              {continueLabel}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </div>
        </>
      )}
      <ConfirmWontFitDownload {...confirmation} />
    </>
  )
}
