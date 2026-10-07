import { useCallback, useEffect, useState } from 'react'
import { IconAlertTriangle, IconLoader2 } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { FamilyLogoMark } from '@/containers/ModelLogo'
import { useHubFileSetup, useModelSetupBytes } from '@/hooks/useModelSetup'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  bytesUnit,
  formatBytes,
  formatProgressPair,
  shortModelName,
} from '@/lib/downloadFormat'
import {
  isFinalSetup,
  isRunningSetup,
  isStandingReadySetup,
  PRISM_PROVIDER,
  setupErrorText as errorText,
  type HubFile,
} from '@/lib/model-setup'
import { getProviderLogo } from '@/lib/utils'
import type {
  ModelSetupError,
  ModelSetupPlan,
} from '@/services/model-setup/types'
import { useModelSetupStore } from '@/stores/model-setup-store'

export type ModelSetupSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: HubFile
  /** What the Hub calls the model, for the title. */
  modelName: string
  /** The id the model registers under, so the Hub recognises it once set up. */
  modelId: string
  /**
   * The model is listed under a provider. A `ready` setup whose model is not
   * listed, or was deleted, is planned again instead of offering its chat.
   */
  installed: boolean
  /** The setup is `ready`: open a chat with the model. */
  onReady: (modelId: string) => void
}

const STALE_PLAN = 'MODEL_SETUP_PLAN_STALE'

/** `442 MB`, `16.50 GB`: a size with its unit, for one value on its own. */
const sizeText = (bytes: number) => `${formatBytes(bytes)} ${bytesUnit(bytes)}`

/**
 * "Set up Bonsai": the one step between a PrismML-only file in the Hub and a
 * chat with it. The core plans what it takes on this machine — the PrismML
 * engine when it is missing or too old, the model, its vision projector — and
 * runs it as one operation that survives this sheet, the app and a restart;
 * the sheet shows the plan, starts it, and follows it.
 */
export function ModelSetupSheet({
  open,
  onOpenChange,
  file,
  modelName,
  modelId,
  installed,
  onReady,
}: ModelSetupSheetProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const setup = useHubFileSetup(file)
  const bytes = useModelSetupBytes(setup)

  const [includeProjector, setIncludeProjector] = useState(true)
  const [offersProjector, setOffersProjector] = useState(false)
  const [plan, setPlan] = useState<ModelSetupPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planStale, setPlanStale] = useState(false)
  const [busy, setBusy] = useState(false)

  const deleted = useModelProvider(
    (state) =>
      !!setup &&
      Array.isArray(state.deletedModels) &&
      state.deletedModels.includes(setup.plan.model_id)
  )
  const ready = !!setup && isStandingReadySetup(setup, { installed, deleted })
  const showPlan = !setup || (isFinalSetup(setup) && !ready)

  const loadPlan = useCallback(async () => {
    setPlanError(null)
    try {
      const next = await serviceHub.modelSetup().plan({
        ...file,
        model_id: modelId,
        include_projector: includeProjector,
      })
      setPlan(next)
      if (next.projector) setOffersProjector(true)
    } catch (error) {
      setPlan(null)
      setPlanError(errorText(error))
    }
  }, [serviceHub, file, modelId, includeProjector])

  useEffect(() => {
    if (open && showPlan) void loadPlan()
  }, [open, showPlan, loadPlan])

  const start = useCallback(async () => {
    if (!plan) return
    setBusy(true)
    setPlanStale(false)
    try {
      const started = await serviceHub.modelSetup().start({
        ...file,
        model_id: modelId,
        include_projector: includeProjector,
        request_id: crypto.randomUUID(),
        plan_digest: plan.digest,
      })
      useModelSetupStore.getState().apply({ type: 'changed', setup: started })
    } catch (error) {
      if ((error as ModelSetupError | undefined)?.code === STALE_PLAN) {
        setPlanStale(true)
        await loadPlan()
      } else {
        setPlanError(errorText(error))
      }
    } finally {
      setBusy(false)
    }
  }, [serviceHub, plan, file, modelId, includeProjector, loadPlan])

  const act = useCallback(
    async (action: 'cancel' | 'resume') => {
      if (!setup) return
      setBusy(true)
      try {
        const next = await serviceHub.modelSetup()[action](setup.setup_id)
        useModelSetupStore.getState().apply({ type: 'changed', setup: next })
      } catch (error) {
        setPlanError(errorText(error))
      } finally {
        setBusy(false)
      }
    },
    [serviceHub, setup]
  )

  const percent =
    bytes.total > 0 ? Math.round((bytes.transferred / bytes.total) * 100) : 0
  const blocked = !!plan && plan.blockers.length > 0
  const engineUpdate =
    (plan ?? setup?.plan)?.verdict.outcome === 'engine_update_required'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg lg:max-w-lg xl:max-w-lg"
        data-testid="model-setup-sheet"
      >
        <DialogHeader className="min-w-0 items-center text-center sm:text-center">
          <div className="mb-2 grid size-14 place-items-center rounded-2xl border bg-secondary/60 shadow-sm">
            <FamilyLogoMark
              src={getProviderLogo(PRISM_PROVIDER)!}
              className="size-7"
            />
          </div>
          <DialogTitle
            className="max-w-full leading-snug break-words"
            title={modelName}
          >
            {t('hub:prismSetupTitle', { model: shortModelName(modelName) })}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {t('hub:prismSetupDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3 text-sm">
          {engineUpdate && (
            <p
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
              data-testid="model-setup-engine-update"
            >
              {t('hub:prismEngineUpdateRequired')}
            </p>
          )}

          {setup && !showPlan && (
            <div
              className="flex flex-col gap-2 rounded-lg border bg-secondary/50 p-3"
              aria-live="polite"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="min-w-0 truncate font-medium"
                  data-testid="model-setup-stage"
                >
                  {t(`hub:prismStage_${setup.stage}`)}
                </span>
                {isRunningSetup(setup) && (
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {percent}%
                  </span>
                )}
              </div>
              {setup.stage !== 'ready' && <Progress value={percent} />}
              {bytes.total > 0 && setup.stage !== 'ready' && (
                <p className="text-xs tabular-nums text-muted-foreground">
                  {formatProgressPair(bytes.transferred, bytes.total)}
                </p>
              )}
              {setup.stage === 'interrupted' && (
                <p className="text-xs text-muted-foreground">
                  {t('hub:prismSetupInterrupted')}
                </p>
              )}
            </div>
          )}

          {setup && showPlan && setup.stage !== 'cancelled' && setup.error && (
            <p className="flex items-start gap-2 text-xs text-destructive">
              <IconAlertTriangle size={14} className="mt-0.5 shrink-0" />
              {t('hub:prismSetupFailed', { error: errorText(setup.error) })}
            </p>
          )}

          {showPlan && !plan && !planError && (
            <p className="flex items-center justify-center gap-2 rounded-lg border bg-secondary/50 p-3 text-muted-foreground">
              <IconLoader2 size={14} className="animate-spin" />
              {t('hub:prismSetupPlanning')}
            </p>
          )}

          {showPlan && plan && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-lg border bg-secondary/50 p-3">
              <dt className="text-muted-foreground">
                {t('hub:prismSetupEngine')}
              </dt>
              <dd className="break-words" data-testid="model-setup-engine">
                {plan.engine
                  ? plan.engine.installed
                    ? t('hub:prismSetupEngineInstalled', {
                        version: plan.engine.version,
                      })
                    : t('hub:prismSetupEngineDownload', {
                        version: plan.engine.version,
                        size: sizeText(plan.engine.download_size),
                      })
                  : t('hub:prismSetupEngineNone')}
              </dd>
              <dt className="text-muted-foreground">
                {t('hub:prismSetupModel')}
              </dt>
              <dd className="break-all">
                {plan.model.file}
                {plan.model.size > 0 && ` · ${sizeText(plan.model.size)}`}
              </dd>
              {plan.projector && (
                <>
                  <dt className="text-muted-foreground">
                    {t('hub:prismSetupProjector')}
                  </dt>
                  <dd className="break-all">
                    {plan.projector.file}
                    {plan.projector.size > 0 &&
                      ` · ${sizeText(plan.projector.size)}`}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">
                {t('hub:prismSetupTotal')}
              </dt>
              <dd className="tabular-nums" data-testid="model-setup-total">
                {sizeText(plan.total_download_bytes)}
                {plan.free_bytes !== null &&
                  ` · ${t('hub:prismSetupFree', { size: sizeText(plan.free_bytes) })}`}
              </dd>
            </dl>
          )}

          {showPlan && offersProjector && (
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <span className="min-w-0">{t('hub:prismSetupVision')}</span>
              <Switch
                checked={includeProjector}
                onCheckedChange={setIncludeProjector}
                disabled={busy}
                data-testid="model-setup-vision"
              />
            </label>
          )}

          {showPlan && plan && blocked && (
            <ul className="flex flex-col gap-1 text-xs text-destructive">
              {plan.blockers.map((blocker) => (
                <li key={blocker.code}>
                  {blocker.message}
                  {blocker.replacement &&
                    ` ${t('hub:prismSetupReplacement', { file: blocker.replacement })}`}
                </li>
              ))}
            </ul>
          )}

          {planStale && (
            <p className="text-xs text-muted-foreground">
              {t('hub:prismSetupPlanChanged')}
            </p>
          )}

          {planError && (
            <p className="text-xs break-words text-destructive" role="alert">
              {planError}
            </p>
          )}
        </div>

        <DialogFooter className="mt-2">
          {setup && ready ? (
            <Button
              size="sm"
              onClick={() => onReady(setup.plan.model_id)}
              data-testid="model-setup-new-chat"
            >
              {t('hub:newChat')}
            </Button>
          ) : setup && !showPlan ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void act('cancel')}
              >
                {t('common:cancel')}
              </Button>
              {setup.stage === 'interrupted' && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void act('resume')}
                >
                  {t('hub:prismSetupResume')}
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              disabled={busy || !plan || blocked}
              onClick={() => void start()}
              data-testid="model-setup-start"
            >
              {setup && setup.stage !== 'ready'
                ? t('hub:prismSetupRetry')
                : t('hub:prismSetupStart')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
