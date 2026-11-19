import { useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'

import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { engineContext } from '@/lib/engine-context'
import { trackSettingsRestart } from '@/lib/settings-restart'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'

type Context = NonNullable<ReturnType<typeof engineContext>>
const usePending = create<Record<string, boolean>>(() => ({}))

export function EngineContextEditor({
  providerId,
  modelId,
  context,
}: {
  providerId: string
  modelId: string
  context: Context
}) {
  const { t } = useTranslation()
  const services = useServiceHub()
  const { at, count, indexOf, configured, setting } = context
  const [draft, setDraft] = useState<number>()
  const busy = usePending((state) => state[providerId])
  const value = draft ?? configured
  const format = (n: number) =>
    n === 0 ? t('common:auto') : n.toLocaleString()

  async function commit(next: number) {
    setDraft(undefined)
    if (next === configured || usePending.getState()[providerId]) return
    usePending.setState({ [providerId]: true })
    let restartToast: ReturnType<typeof toast.loading> | undefined
    try {
      const changed = {
        ...setting,
        controller_props: { ...setting.controller_props, value: next },
      }
      await services.providers().updateSettings(providerId, [changed])
      const store = useModelProvider.getState()
      const provider = store.getProviderByName(providerId)
      if (!provider) return
      const settings = provider.settings.map((item) =>
        item.key === setting.key ? changed : item
      )
      store.updateProvider(providerId, { settings })
      const models = services.models()
      if (!(await models.getActiveModels(providerId)).includes(modelId)) return
      restartToast = toast.loading(t('assistants:contextRestarting'), {
        description: t('assistants:contextStoppingModel'),
      })
      let restarted: boolean
      try {
        restarted = await trackSettingsRestart(providerId, modelId, async () => {
          const stopped = await models.stopModel(modelId, providerId)
          if (stopped && !stopped.success)
            throw new Error(stopped.error || t('assistants:contextApplyFailed'))
          const current = useModelProvider.getState()
          const fresh = current.getProviderByName(providerId)
          if (
            !fresh ||
            current.selectedProvider !== providerId ||
            current.selectedModel?.id !== modelId
          ) return false

          toast.loading(t('assistants:contextRestarting'), {
            id: restartToast,
            description: t('assistants:contextLoadingModel'),
          })
          await models.startModel(fresh, modelId, true)
          if (!(await models.getActiveModels(providerId)).includes(modelId))
            throw new Error(t('assistants:contextModelUnavailable'))
          return true
        })
      } finally {
        syncActiveModelsFromEngines(await models.getActiveModels())
      }
      if (restarted) {
        toast.success(t('assistants:contextRestarted', { limit: format(next) }), {
          id: restartToast,
        })
      } else {
        toast.dismiss(restartToast)
      }
    } catch (error) {
      toast.error(t('assistants:contextApplyFailed'), {
        id: restartToast,
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setDraft(undefined)
      usePending.setState({ [providerId]: false })
    }
  }

  if (context.missingModelLimit) {
    return <p className="border-t border-border pt-4 text-sm text-muted-foreground">
      {t('assistants:checkpointContextUnknown')}
    </p>
  }
  const maximum = at(count - 1)
  const sliderValue = context.exceedsLimit && draft === undefined ? maximum : value
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">{t('assistants:contextSize')}</span>
        <span className="font-mono tabular-nums">{format(sliderValue)}</span>
      </div>
      <p className="text-sm leading-snug text-muted-foreground">
        {t('assistants:engineContextScope')}
      </p>
      {context.exceedsLimit && (
        <Button type="button" size="sm" variant="outline" disabled={busy}
          onClick={() => void commit(maximum)}>
          {t('assistants:useCheckpointLimit', { limit: format(maximum) })}
        </Button>
      )}
      <Slider
        aria-label={t('assistants:contextSize')}
        aria-valuetext={format(sliderValue)}
        disabled={busy || count < 2}
        min={0}
        max={count - 1}
        step={1}
        value={[indexOf(value)]}
        onValueChange={([index]) => setDraft(at(index))}
        onValueCommit={([index]) => void commit(at(index))}
      />
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{format(at(0))}</span>
        <span>{format(at(count - 1))}</span>
      </div>
    </div>
  )
}
