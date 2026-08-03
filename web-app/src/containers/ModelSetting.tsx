import { IconSettings } from '@tabler/icons-react'
import debounce from 'lodash.debounce'
import { useEffect, useMemo } from 'react'

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { cn, getModelDisplayName } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { restartLocalModel } from '@/utils/restartLocalModel'

type ModelSettingProps = {
  provider: ProviderObject
  model: Model
}

// Sampling parameters are edited globally in the Sampling popover; their
// legacy load-time twins under `model.settings.*` are hidden from this gear
// to avoid two competing sources of truth. Data on disk is preserved.
const LEGACY_SAMPLING_KEYS = new Set<string>([
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'repeat_penalty',
  'repeat_last_n',
  'presence_penalty',
  'frequency_penalty',
])

const RESTART_REQUIRED_SETTINGS = new Set([
  'ctx_len',
  'ngl',
  'chat_template',
  'offload_mmproj',
  'batch_size',
  'cpu_moe',
  'n_cpu_moe',
  'override_tensor_buffer_t',
  'no_kv_offload',
])

export function ModelSetting({
  model,
  provider,
}: ModelSettingProps) {
  const { updateProvider } = useModelProvider()
  const { t } = useTranslation()
  const serviceHub = useServiceHub()

  const debouncedRestartModel = useMemo(
    () =>
      debounce(async (modelId: string, providerName: string) => {
        try {
          await restartLocalModel(serviceHub, providerName, modelId)
        } catch (error) {
          console.error('Failed to restart model after settings change:', error)
        }
      }, 500),
    [serviceHub]
  )

  useEffect(
    () => () => {
      debouncedRestartModel.cancel()
    },
    [debouncedRestartModel]
  )

  const handleSettingChange = (
    key: string,
    value: string | boolean | number
  ) => {
    if (!provider) return

    const freshProvider =
      useModelProvider.getState().getProviderByName(provider.provider) ??
      provider
    const freshModel =
      freshProvider.models.find((candidate) => candidate.id === model.id) ??
      model

    const updatedModel = {
      ...freshModel,
      settings: {
        ...freshModel.settings,
        [key]: {
          ...(freshModel.settings?.[key] != null
            ? freshModel.settings?.[key]
            : {}),
          controller_props: {
            ...(freshModel.settings?.[key]?.controller_props ?? {}),
            value: value,
          },
        },
      },
    }

    // Find the model index in the provider's models array
    const modelIndex = freshProvider.models.findIndex((m) => m.id === model.id)

    if (modelIndex !== -1) {
      // Create a copy of the provider's models array
      const updatedModels = [...freshProvider.models]

      // Update the specific model in the array
      updatedModels[modelIndex] = updatedModel as Model

      // Update the provider with the new models array
      updateProvider(freshProvider.provider, {
        models: updatedModels,
      })

      if (RESTART_REQUIRED_SETTINGS.has(key)) {
        // Check if model is running before restarting it with new settings
        serviceHub
          .models()
          .getActiveModels(freshProvider.provider)
          .then((activeModels) => {
            if (activeModels.includes(model.id)) {
              debouncedRestartModel(model.id, freshProvider.provider)
            }
          })
      }
    }
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-xs">
          <IconSettings size={18} className="text-muted-foreground" />
        </Button>
      </SheetTrigger>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {t('common:modelSettings.title', {
              modelId: getModelDisplayName(model),
            })}
          </SheetTitle>
          <SheetDescription className='text-xs leading-normal'>
            {t('common:modelSettings.description')}
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 space-y-8 pb-4">
          {Object.entries(model.settings || {})
          .reduce<[string, unknown][]>((acc, entry) => {
            if (entry[0] === 'auto_increase_ctx_len') return acc
            if (entry[0] === 'ctx_len') {
              const autoIncrease = Object.entries(model.settings || {}).find(
                ([k]) => k === 'auto_increase_ctx_len'
              )
              if (autoIncrease) acc.push(autoIncrease)
            }
            acc.push(entry)
            return acc
          }, [])
          .filter(([key]) => {
            // Sampling now lives solely in the global Sampling popover
            // (model bar). Hide the legacy load-time sampling controls here
            // so there is exactly one place to tune sampling. The persisted
            // `model.settings.*` values are left untouched on disk.
            if (LEGACY_SAMPLING_KEYS.has(key)) return false
            // MLX models only support context size setting
            if (provider.provider === 'mlx') {
              return key === 'ctx_len'
            }
            return true
          })
          .map(([key, value]) => {
            const config = value as ProviderSetting
            return (
              <div key={key} className="space-y-2">
                <div
                  className={cn(
                    'flex items-start justify-between gap-8',
                    (key === 'chat_template' ||
                      key === 'override_tensor_buffer_t') &&
                      'flex-col gap-1 w-full'
                  )}
                >
                  <div className="mb-1 truncate">
                    <span title={config.title} className="font-medium">{config.title}</span>
                  </div>
                  <DynamicControllerSetting
                    key={config.key}
                    title={config.title}
                    description={config.description}
                    controllerType={config.controller_type}
                    controllerProps={{
                      ...config.controller_props,
                      value: config.controller_props?.value,
                    }}
                    onChange={(newValue) => handleSettingChange(key, newValue)}
                  />
                </div>
                <p className="text-muted-foreground leading-normal text-xs">
                  {config.description}
                </p>
              </div>
            )
          })}
        </div>
      </SheetContent>
    </Sheet>
  )
}
