import { useCallback, useEffect, useState } from 'react'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { FamilyLogoMark } from '@/containers/ModelLogo'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { bytesUnit, formatBytes, shortModelName } from '@/lib/downloadFormat'
import {
  PRISM_PROVIDER,
  setupErrorText as errorText,
  type HubFile,
} from '@/lib/model-setup'
import { getProviderLogo } from '@/lib/utils'
import { loadPrismSetupPlan } from '@/services/model-setup/prism-setup'
import type {
  PrismSetupBlocker,
  PrismSetupPlan,
} from '@/services/model-setup/types'

export type ModelSetupSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  file: HubFile
  /** What the Hub calls the model, for the title. */
  modelName: string
  /** The id the model registers under, so the Hub recognises it once downloaded. */
  modelId: string
  /** Set up: run the plan the sheet showed. The sheet closes; the row and the download panel follow. */
  onStart: (plan: PrismSetupPlan) => void
}

/** `442 MB`, `16.50 GB`: a size with its unit, for one value on its own. */
const sizeText = (bytes: number) => `${formatBytes(bytes)} ${bytesUnit(bytes)}`

/** What decides the work: a plan that differs in any of these is shown again before it runs. */
const planKey = (plan: PrismSetupPlan) =>
  JSON.stringify([
    plan.verdict.outcome,
    plan.engine,
    plan.model,
    plan.projector,
    plan.blockers.map((blocker) => blocker.code),
  ])

type Translate = (key: string, options?: Record<string, unknown>) => string

function blockerText(blocker: PrismSetupBlocker, t: Translate): string {
  switch (blocker.code) {
    case 'unsupported':
      return blocker.message
    case 'legacy_artifact':
      return blocker.replacement
        ? `${blocker.message} ${t('hub:prismSetupReplacement', { file: blocker.replacement })}`
        : blocker.message
    case 'no_engine_build':
      return t('hub:prismBlocker_no_engine_build')
    case 'insufficient_disk_space':
      return t('hub:prismBlocker_insufficient_disk_space', {
        needed: sizeText(blocker.needed),
        free: sizeText(blocker.free),
      })
  }
}

/**
 * "Set up Bonsai": the one step between a PrismML-only file in the Hub and its
 * download. The app plans what it takes on this machine from what the core
 * reports — the PrismML engine when it is missing or too old, the model, its
 * vision projector, the bytes and what blocks it — and shows it. Set up reads
 * the plan again and runs it only if nothing changed; the row and the
 * download panel follow it from there.
 */
export function ModelSetupSheet({
  open,
  onOpenChange,
  file,
  modelName,
  modelId,
  onStart,
}: ModelSetupSheetProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()

  const [includeProjector, setIncludeProjector] = useState(true)
  const [plan, setPlan] = useState<PrismSetupPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planChanged, setPlanChanged] = useState(false)
  const [busy, setBusy] = useState(false)

  const loadPlan = useCallback(
    () =>
      loadPrismSetupPlan(serviceHub.modelSetup(), {
        ...file,
        model_id: modelId,
        include_projector: includeProjector,
      }),
    [serviceHub, file, modelId, includeProjector]
  )

  useEffect(() => {
    if (!open) return
    let current = true
    setPlanError(null)
    setPlanChanged(false)
    loadPlan()
      .then((next) => current && setPlan(next))
      .catch((error) => {
        if (!current) return
        setPlan(null)
        setPlanError(errorText(error))
      })
    return () => {
      current = false
    }
  }, [open, loadPlan])

  const start = useCallback(async () => {
    if (!plan) return
    setBusy(true)
    try {
      const fresh = await loadPlan()
      if (planKey(fresh) !== planKey(plan)) {
        setPlan(fresh)
        setPlanChanged(true)
        return
      }
      onOpenChange(false)
      onStart(fresh)
    } catch (error) {
      setPlanError(errorText(error))
    } finally {
      setBusy(false)
    }
  }, [plan, loadPlan, onOpenChange, onStart])

  const blocked = !!plan && plan.blockers.length > 0
  const engineUpdate = plan?.verdict.outcome === 'engine_update_required'

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

          {!plan && !planError && (
            <p className="flex items-center justify-center gap-2 rounded-lg border bg-secondary/50 p-3 text-muted-foreground">
              <IconLoader2 size={14} className="animate-spin" />
              {t('hub:prismSetupPlanning')}
            </p>
          )}

          {plan && (
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

          {plan?.offers_projector && (
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

          {plan && blocked && (
            <ul className="flex flex-col gap-1 text-xs text-destructive">
              {plan.blockers.map((blocker) => (
                <li key={blocker.code}>{blockerText(blocker, t)}</li>
              ))}
            </ul>
          )}

          {planChanged && (
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
          <Button
            size="sm"
            disabled={busy || !plan || blocked}
            onClick={() => void start()}
            data-testid="model-setup-start"
          >
            {t('hub:prismSetupStart')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
