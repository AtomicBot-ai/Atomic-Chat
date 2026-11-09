import { isFastFlowLmInstallFinished } from '@/lib/fastflowlm/install-state'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState, type Ref } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { EngineManager } from '@janhq/core'
import type { FastFlowLmCheckResult } from '@atomic-chat/core/contracts'
import { Button } from '@/components/ui/button'
import { DeleteModelAction } from '@/containers/hub/DeleteModelAction'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { engineSettingsLink } from '@/lib/engine-settings-link'
import { cancelTransfer } from '@/services/diffusion/transfer'
import { checkFastFlowLmModel } from '@/services/fastflowlm/core'
import {
  fastFlowLmDownloadId,
  fastFlowLmInstallJobs,
  installFastFlowLm,
} from '@/services/fastflowlm/install'
import type { CatalogModel } from '@/services/models/types'
import { formatBytes } from '@/lib/utils'
import { switchToModel } from '@/utils/switchModel'
import { route } from '@/constants/routes'
import type { FastFlowLmDefinition } from '@atomic-chat/core/contracts'
import type { FastFlowLmInstallJob } from '@/services/fastflowlm/install'

/** One explicit FLM variant: its own license, complete size, capabilities and core verdict. */
export function FastFlowLmDownloadOptions({
  model,
  sectionRef,
}: {
  model: CatalogModel
  sectionRef?: Ref<HTMLElement>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const fields = model.fastflowlm
  const id = fields?.variant_id ?? model.model_name.replace(/^fastflowlm\//, '')
  const taskId = fastFlowLmDownloadId(id)
  const token = useGeneralSetting((state) => state.huggingfaceToken)
  const provider = useModelProvider((state) =>
    state.providers.find((p) => p.provider === 'fastflowlm')
  )
  const installed = !!provider?.models.some((m) => m.id === id)
  const [verdict, setVerdict] = useState<FastFlowLmCheckResult>()
  const [resumable, setResumable] = useState(false)
  const [journalKnown, setJournalKnown] = useState(false)
  const [savedJob, setSavedJob] = useState<FastFlowLmInstallJob>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const progress = useDownloadStore(
    (state) => state.downloads[taskId]?.progress
  )
  useEffect(() => {
    let alive = true
    setVerdict(undefined)
    void checkFastFlowLmModel(
      fields ? { descriptor: fields } : { model_id: id }
    )
      .then((answer) => {
        if (alive) setVerdict(answer)
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
    const refreshJob = () =>
      fastFlowLmInstallJobs()
        .then((jobs) => {
          if (!alive) return
          const job = jobs.find(
            (job) => job.model_id === id && !isFastFlowLmInstallFinished(job)
          )
          setSavedJob(job)
          setResumable(!!job)
          setBusy(!!job?.running)
          setJournalKnown(true)
        })
        .catch((e) => {
          if (alive) setError(String(e))
        })
    void refreshJob()
    const stop = listen('atomic-fastflowlm-models-changed', () => {
      void refreshJob()
    }).catch(() => () => {})
    return () => {
      alive = false
      void stop.then((unlisten) => unlisten())
    }
  }, [fields, id])
  const download = async () => {
    const selected =
      fields ??
      (savedJob
        ? ({
            ...savedJob.plan.descriptor,
            name: savedJob.plan.name,
          } as FastFlowLmDefinition)
        : undefined)
    if (!selected) return
    const store = useDownloadStore.getState()
    store.setDownloadOrigin(taskId, selected.name)
    store.clearPausedDownload(taskId)
    store.addLocalDownloadingModel(taskId)
    setBusy(true)
    setError(undefined)
    try {
      await installFastFlowLm(selected, token)
      const engine = EngineManager.instance().engines.get('fastflowlm') as
        | { invalidateModelList?: () => void }
        | undefined
      engine?.invalidateModelList?.()
      setResumable(false)
      setSavedJob(undefined)
      useModelProvider
        .getState()
        .setProviders(await serviceHub.providers().getProviders())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      try {
        const job = (await fastFlowLmInstallJobs()).find(
          (entry) =>
            entry.model_id === id && !isFastFlowLmInstallFinished(entry)
        )
        setSavedJob(job)
        setResumable(!!job)
      } catch {
        setResumable(true)
      }
    } finally {
      setBusy(false)
      store.removeLocalDownloadingModel(taskId)
    }
  }
  const requiresSetup =
    verdict &&
    [
      'engine-not-installed',
      'environment-not-ready',
      'requires-newer-engine',
    ].includes(verdict.verdict)
  return (
    <section
      ref={sectionRef}
      className="min-w-0 space-y-3 rounded-lg border p-4"
    >
      {fields && (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt>{t('hub:fastflowlm.download')}</dt>
            <dd>
              {formatBytes(
                fields.files.reduce((sum, file) => sum + file.size, 0)
              )}
            </dd>
            <dt>{t('hub:fastflowlm.license')}</dt>
            <dd className="break-words">{fields.license}</dd>
            <dt>{t('hub:fastflowlm.context')}</dt>
            <dd>{fields.context_length.toLocaleString()}</dd>
          </dl>
          {fields.qualification.status !== 'qualified' && (
            <p className="text-xs text-muted-foreground">
              {t('hub:fastflowlm.qualification')}
            </p>
          )}
          {fields.gated && (
            <div className="min-w-0 space-y-2 text-sm">
              <p>{t('hub:fastflowlm.gated')}</p>
              {fields.sources
                .filter((source) => source.host !== 'github')
                .map((source) => (
                  <a
                    key={source.id}
                    className="block break-all underline"
                    href={`https://huggingface.co/${source.repo.split('/').map(encodeURIComponent).join('/')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.repo}
                  </a>
                ))}
              <Button
                variant="outline"
                onClick={() => void navigate({ to: route.settings.general })}
              >
                {t('hub:fastflowlm.setToken')}
              </Button>
            </div>
          )}
        </>
      )}
      <p role="status" className="break-words text-sm text-muted-foreground">
        {verdict?.reason ?? (!verdict ? t('hub:fastflowlm.checking') : '')}
      </p>
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {busy ? (
          <Button variant="outline" onClick={() => void cancelTransfer(taskId)}>
            {t('common:cancelDownload')}{' '}
            {progress === undefined ? '' : `${Math.round(progress * 100)}%`}
          </Button>
        ) : journalKnown && installed && !resumable && provider ? (
          <>
            <DeleteModelAction modelId={id} provider="fastflowlm" />
            {fields && verdict?.verdict === 'ok' && (
              <Button
                variant="outline"
                disabled={!!fields.gated && !token}
                onClick={() => void download()}
              >
                {t('hub:fastflowlm.update')}
              </Button>
            )}
            <Button
              onClick={() => {
                useModelProvider
                  .getState()
                  .selectModelProvider('fastflowlm', id)
                void switchToModel({
                  modelId: id,
                  providerName: 'fastflowlm',
                  serviceHub,
                }).catch((e) => setError(String(e)))
                void navigate({
                  to: route.home,
                  params: {},
                  search: { threadModel: { id, provider: 'fastflowlm' } },
                })
              }}
            >
              {t('common:newChat')}
            </Button>
          </>
        ) : requiresSetup && !resumable ? (
          <Button
            variant="outline"
            onClick={() => void navigate(engineSettingsLink('fastflowlm'))}
          >
            {t('hub:fastflowlm.setup')}
          </Button>
        ) : (
          journalKnown &&
          ((fields && verdict?.verdict === 'ok') || resumable) && (
            <Button
              disabled={
                savedJob && savedJob.state !== 'downloading'
                  ? false
                  : !!fields?.gated && !token
              }
              onClick={() => void download()}
            >
              {t(
                resumable ? 'hub:fastflowlm.resume' : 'hub:fastflowlm.install'
              )}
            </Button>
          )
        )}
      </div>
    </section>
  )
}
