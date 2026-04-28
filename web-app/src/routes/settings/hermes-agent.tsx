import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useHermesAgentModel } from '@/hooks/useHermesAgentModel'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { cn } from '@/lib/utils'
import { useState, useMemo, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { getModelToStart } from '@/utils/getModelToStart'
import { invoke } from '@tauri-apps/api/core'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { IconChevronDown, IconX, IconCopy, IconCheck } from '@tabler/icons-react'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import Capabilities from '@/containers/Capabilities'
import { getModelDisplayName, isLocalProvider } from '@/lib/utils'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.hermes_agent as any)({
  component: HermesAgentIntegration,
})

function HermesAgentIntegration() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const {
    corsEnabled,
    verboseLogs,
    serverHost,
    serverPort,
    setServerPort,
    apiPrefix,
    apiKey,
    trustedHosts,
    proxyTimeout,
    setLastServerModels,
  } = useLocalApiServer()

  const { serverStatus, setServerStatus } = useAppState()
  const { providers, selectedModel, selectedProvider, getProviderByName } =
    useModelProvider()

  const { config, setModel, clearModel } = useHermesAgentModel()

  const [isModelLoading, setIsModelLoading] = useState(false)
  const [configuredValues, setConfiguredValues] = useState<{
    model: string
    apiUrl: string
    contextLength: number
  } | null>(null)

  const availableModels = useMemo(() => {
    return providers
      .filter((p) => p.active)
      .flatMap((p) =>
        p.models.map((m) => ({
          ...m,
          providerName: p.provider,
          isLocal: isLocalProvider(p.provider),
          hasApiKey: !!p.api_key?.length,
        }))
      )
      .filter((m) => (m.isLocal ? m.id : m.hasApiKey))
  }, [providers])

  useEffect(() => {
    if (!config.model && availableModels.length > 0) {
      setModel(availableModels[0].id)
    }
  }, [config.model, availableModels, setModel])

  const MIN_HERMES_CTX = 20000

  const getModelCtxLen = (modelId: string): number => {
    for (const p of providers) {
      const m = p.models.find((m) => m.id === modelId)
      if (m?.settings?.ctx_len?.controller_props?.value != null) {
        const val = Number(m.settings.ctx_len.controller_props.value)
        // 0 means "loaded from model" — treat as unset
        return val > 0 ? val : MIN_HERMES_CTX
      }
    }
    return MIN_HERMES_CTX
  }

  const ensureMinCtx = (modelId: string) => {
    for (const p of providers) {
      const m = p.models.find((m) => m.id === modelId)
      if (m?.settings?.ctx_len?.controller_props) {
        const current = Number(m.settings.ctx_len.controller_props.value) || 0
        if (current < MIN_HERMES_CTX) {
          m.settings.ctx_len.controller_props.value = MIN_HERMES_CTX
        }
        return
      }
    }
  }

  const handleSaveEnable = async () => {
    const hermesHost = serverHost === '0.0.0.0' ? '127.0.0.1' : serverHost
    const apiUrl = `http://${hermesHost}:${serverPort}`
    const selectedHermesModel = config.model

    const startServer = async (): Promise<void> => {
      const modelsToCheck = selectedHermesModel ? [selectedHermesModel] : []
      const loadedModels =
        (await serviceHub.models().getActiveModels()) || []
      const modelsToStart = modelsToCheck.filter(
        (m) => !loadedModels.includes(m)
      )

      if (modelsToStart.length > 0) {
        setIsModelLoading(true)
        for (const modelId of modelsToStart) {
          ensureMinCtx(modelId)
          const providerWithModel = providers.find((p) =>
            p.models.some((m) => m.id === modelId)
          )
          if (providerWithModel) {
            await serviceHub
              .models()
              .startModel(providerWithModel, modelId, true)
          }
        }
        setIsModelLoading(false)
        await serviceHub
          .models()
          .getActiveModels()
          .then((models) => syncActiveModelsFromEngines(models || []))
        await new Promise((resolve) => setTimeout(resolve, 500))
      } else if (loadedModels.length > 0 && !selectedHermesModel) {
        // No model explicitly selected — use whatever is already loaded
      } else if (!selectedHermesModel) {
        const modelToStart = getModelToStart({
          selectedModel,
          selectedProvider,
          getProviderByName,
        })
        if (modelToStart) {
          ensureMinCtx(modelToStart.model)
          setIsModelLoading(true)
          await serviceHub
            .models()
            .startModel(modelToStart.provider, modelToStart.model, true)
          setIsModelLoading(false)
          await serviceHub
            .models()
            .getActiveModels()
            .then((models) => syncActiveModelsFromEngines(models || []))
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }

      let actualPort: number | undefined
      try {
        actualPort = await window.core?.api?.startServer({
          host: serverHost,
          port: serverPort,
          prefix: apiPrefix,
          apiKey,
          trustedHosts,
          isCorsEnabled: corsEnabled,
          isVerboseEnabled: verboseLogs,
          proxyTimeout: proxyTimeout,
        })
      } catch (startErr) {
        const msg =
          startErr instanceof Error ? startErr.message : String(startErr)
        if (!msg.includes('already running')) throw startErr
      }

      if (actualPort && actualPort !== serverPort) {
        setServerPort(actualPort)
      }
      setServerStatus('running')

      const activeModels = await serviceHub
        .models()
        .getActiveModels()
        .catch(() => [] as string[])
      if (activeModels.length > 0) {
        const serverModels = activeModels.flatMap((id) => {
          const p = providers.find((p) => p?.models?.some((m) => m.id === id))
          return p ? [{ model: id, provider: p.provider }] : []
        })
        if (serverModels.length > 0) setLastServerModels(serverModels)
      }
    }

    try {
      if (serverStatus === 'stopped') {
        toast.info('Starting server...', {
          description: 'Preparing server for Hermes Agent',
        })
        await startServer()
      }

      const modelToUse =
        selectedHermesModel ||
        (await serviceHub
          .models()
          .getActiveModels()
          .then((m) => m?.[0])
          .catch(() => null))

      if (!modelToUse) {
        toast.error('No model selected or loaded')
        return
      }

      const rawCtx = getModelCtxLen(modelToUse)
      const effectiveCtx = Math.max(rawCtx, MIN_HERMES_CTX)

      const fullApiUrl = `${apiUrl}${apiPrefix}`
      await invoke('configure_hermes_agent', {
        apiUrl: fullApiUrl,
        model: modelToUse,
        apiKey: apiKey || undefined,
        contextLength: effectiveCtx,
      })

      setConfiguredValues({
        model: modelToUse,
        apiUrl: fullApiUrl,
        contextLength: effectiveCtx,
      })

      toast.success(
        `Hermes Agent configured (ctx: ${effectiveCtx}). Run \`hermes\` in terminal.`,
        { duration: 8000 }
      )
    } catch (error) {
      console.error('Failed to configure Hermes Agent:', error)
      const errorMsg = error instanceof Error ? error.message : String(error)
      toast.error('Failed to configure Hermes Agent', {
        description: errorMsg,
      })
    }
  }

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            <Card
              header={
                <div className="mb-3 flex w-full items-center gap-3">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className="shrink-0"
                  >
                    <path
                      d="M12 2C12 2 9 6 9 9C9 10.1 9.4 11.1 10 11.8L7 20H9L10.5 16H13.5L15 20H17L14 11.8C14.6 11.1 15 10.1 15 9C15 6 12 2 12 2Z"
                      fill="currentColor"
                      className="text-emerald-500"
                    />
                    <path
                      d="M8 9C6.5 9 5 10 5 12L7 11M16 9C17.5 9 19 10 19 12L17 11"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      className="text-emerald-500"
                    />
                  </svg>
                  <h1 className="text-foreground font-studio font-medium text-base">
                    Hermes Agent integration
                  </h1>
                </div>
              }
            >
              <CardItem
                title="Model"
                description="The model Hermes Agent will use for inference"
                actions={
                  <ModelSelector
                    providers={providers}
                    selectedModel={config.model}
                    onSelect={(model) => setModel(model)}
                    placeholder="Select a model"
                  />
                }
              />

              <div className="flex mt-2 justify-end gap-2 border-t pt-4">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    clearModel()
                    setConfiguredValues(null)
                    try {
                      await invoke('clear_hermes_agent_config')
                      toast.success('Hermes Agent settings cleared')
                    } catch (e) {
                      toast.error(`Failed to clear config: ${e}`)
                    }
                  }}
                >
                  Reset
                </Button>

                <Button
                  size="sm"
                  onClick={handleSaveEnable}
                  disabled={isModelLoading}
                >
                  {isModelLoading ? 'Loading model...' : 'Save & Enable'}
                </Button>
              </div>
            </Card>

            {configuredValues && (
              <ManualConfigPanel
                model={configuredValues.model}
                apiUrl={configuredValues.apiUrl}
                contextLength={configuredValues.contextLength}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CopyableField({
  label,
  value,
}: {
  label: string
  value: string
}) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">
        <code className="text-xs font-mono bg-secondary/50 px-2 py-0.5 rounded truncate">
          {value}
        </code>
        <button
          onClick={copy}
          className="shrink-0 p-0.5 rounded hover:bg-secondary/60 text-muted-foreground"
        >
          {copied ? (
            <IconCheck size={13} className="text-emerald-500" />
          ) : (
            <IconCopy size={13} />
          )}
        </button>
      </div>
    </div>
  )
}

function ManualConfigPanel({
  model,
  apiUrl,
  contextLength,
}: {
  model: string
  apiUrl: string
  contextLength: number
}) {
  const yamlSnippet = [
    'model:',
    `  default: "${model}"`,
    '  provider: "custom"',
    `  base_url: "${apiUrl}"`,
    '',
    'custom_providers:',
    '- name: atomic-chat',
    `  base_url: ${apiUrl}`,
    `  model: ${model}`,
    '  models:',
    `    ${model}:`,
    `      context_length: ${contextLength}`,
  ].join('\n')

  const [yamlCopied, setYamlCopied] = useState(false)

  const copyYaml = () => {
    navigator.clipboard.writeText(yamlSnippet)
    setYamlCopied(true)
    setTimeout(() => setYamlCopied(false), 1500)
  }

  return (
    <Card
      header={
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-foreground font-studio font-medium text-sm">
            Manual configuration
          </h2>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600">
            Active
          </span>
        </div>
      }
    >
      <p className="text-xs text-muted-foreground mb-3">
        These values have been written to{' '}
        <code className="bg-secondary/50 px-1 rounded">~/.hermes/config.yaml</code>.
        If you need to configure another machine manually, use the values below.
      </p>

      <div className="divide-y divide-border/50">
        <CopyableField label="model.default" value={model} />
        <CopyableField label="model.provider" value="custom" />
        <CopyableField label="model.base_url" value={apiUrl} />
        <CopyableField
          label="context_length"
          value={String(contextLength)}
        />
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-muted-foreground">
            config.yaml snippet
          </span>
          <button
            onClick={copyYaml}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {yamlCopied ? (
              <>
                <IconCheck size={13} className="text-emerald-500" />
                <span className="text-emerald-500">Copied</span>
              </>
            ) : (
              <>
                <IconCopy size={13} />
                <span>Copy YAML</span>
              </>
            )}
          </button>
        </div>
        <pre className="text-xs font-mono bg-secondary/30 rounded-md p-3 overflow-x-auto whitespace-pre">
          {yamlSnippet}
        </pre>
      </div>
    </Card>
  )
}

function ModelSelector({
  providers,
  selectedModel,
  onSelect,
  placeholder = 'Select a model',
}: {
  providers: ModelProvider[]
  selectedModel: string | null
  onSelect: (modelId: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const availableModels = useMemo(() => {
    return providers
      .filter((p) => p.active)
      .flatMap((p) =>
        p.models.map((m) => ({
          ...m,
          providerName: p.provider,
          isLocal: isLocalProvider(p.provider),
          hasApiKey: !!p.api_key?.length,
        }))
      )
      .filter((m) => (m.isLocal ? m.id : m.hasApiKey))
  }, [providers])

  const filteredModels = useMemo(() => {
    if (!searchValue.trim()) return availableModels
    const search = searchValue.toLowerCase()
    return availableModels.filter(
      (m) =>
        m.id.toLowerCase().includes(search) ||
        (m.displayName?.toLowerCase() ?? '').includes(search) ||
        m.providerName.toLowerCase().includes(search)
    )
  }, [availableModels, searchValue])

  const groupedModels = useMemo(() => {
    const groups: Record<string, typeof filteredModels> = {}
    filteredModels.forEach((model) => {
      if (!groups[model.providerName]) {
        groups[model.providerName] = []
      }
      groups[model.providerName].push(model)
    })
    return groups
  }, [filteredModels])

  const currentModel = availableModels.find((m) => m.id === selectedModel)

  const handleSelect = (model: (typeof filteredModels)[0]) => {
    onSelect(model.id)
    setOpen(false)
    setSearchValue('')
  }

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)
    if (!isOpen) {
      setSearchValue('')
    } else {
      setTimeout(() => searchInputRef.current?.focus(), 100)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[280px]">
          <span className="flex items-center gap-2 truncate leading-normal">
            {selectedModel && currentModel ? (
              <>
                <span
                  className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full shrink-0',
                    currentModel.isLocal
                      ? 'bg-emerald-500/10 text-emerald-600'
                      : 'bg-blue-500/10 text-blue-600'
                  )}
                >
                  {currentModel.isLocal ? 'Local' : 'Remote'}
                </span>
                <span>{getModelDisplayName(currentModel)}</span>
              </>
            ) : (
              placeholder
            )}
          </span>
          <IconChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[280px] p-0 bg-background/95 border"
        align="end"
        sideOffset={8}
      >
        <div className="flex flex-col size-full">
          <div className="relative p-2 border-b">
            <input
              ref={searchInputRef}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="Search models..."
              className="text-sm font-normal outline-0 w-full"
            />
            {searchValue.length > 0 && (
              <div className="absolute right-2 top-0 bottom-0 flex items-center justify-center">
                <IconX
                  size={16}
                  className="text-muted-foreground cursor-pointer"
                  onClick={() => setSearchValue('')}
                />
              </div>
            )}
          </div>

          <div className="max-h-[300px] overflow-y-auto">
            {Object.keys(groupedModels).length === 0 && searchValue ? (
              <div className="py-3 px-4 text-sm text-muted-foreground">
                No models found for &quot;{searchValue}&quot;
              </div>
            ) : (
              <div className="py-1">
                {Object.entries(groupedModels).map(([providerKey, models]) => {
                  const providerInfo = providers.find(
                    (p) => p.provider === providerKey
                  )
                  if (!providerInfo) return null

                  return (
                    <div
                      key={providerKey}
                      className="bg-secondary/30 rounded-sm my-1.5 mx-1.5 first:mt-1 py-1"
                    >
                      <div className="flex items-center gap-1.5 px-2 py-1">
                        <ProvidersAvatar provider={providerInfo} />
                        <span className="capitalize text-sm font-medium text-muted-foreground">
                          {providerKey}
                        </span>
                      </div>

                      {models.map((model) => {
                        const isSelected = selectedModel === model.id
                        const capabilities = model.capabilities || []

                        return (
                          <div
                            key={model.id}
                            title={model.id}
                            onClick={() => handleSelect(model)}
                            className={cn(
                              'mx-1 mb-1 px-2 py-1.5 rounded-sm cursor-pointer flex items-center gap-2 transition-all duration-200',
                              'hover:bg-secondary/40',
                              isSelected &&
                                'bg-secondary/60 hover:bg-secondary/60'
                            )}
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span
                                className="text-sm truncate"
                                title={model.id}
                              >
                                {getModelDisplayName(model)}
                              </span>
                              <div className="flex-1"></div>
                              {capabilities.length > 0 && (
                                <div className="shrink-0 -mr-1.5">
                                  <Capabilities capabilities={capabilities} />
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
