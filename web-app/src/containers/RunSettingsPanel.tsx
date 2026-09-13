import { useState, type ReactNode } from 'react'
import { ChevronDown, PanelRight } from 'lucide-react'
import { IconChevronDown, IconCirclePlus } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { AvatarEmoji } from '@/containers/AvatarEmoji'
import { ModelSettingsList } from '@/containers/ModelSetting'
import { ParametersSection } from '@/containers/ParametersSection'
import AddEditAssistant from '@/containers/dialogs/AddEditAssistant'
import { useAssistant } from '@/hooks/useAssistant'
import { useEffectiveAssistant } from '@/hooks/useEffectiveAssistant'
import {
  formatContextSize,
  useModelContextLength,
} from '@/hooks/useModelContextLength'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  customModelSettingKeys,
  RESTART_REQUIRED_SETTINGS,
  withDefaultModelSettings,
} from '@/lib/model-settings-defaults'
import {
  hasCustomSampling,
  RUN_SETTINGS_SAMPLING_KEYS,
  withDefaultSampling,
} from '@/lib/sampling-defaults'
import { cn } from '@/lib/utils'
import { restartLocalModel } from '@/utils/restartLocalModel'

type RunSettingsPanelProps = {
  onClose: () => void
}

const HEADER_ICON_BUTTON =
  'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-foreground focus-visible:ring-2'

function Section({
  title,
  action,
  children,
  defaultOpen = true,
}: {
  title: string
  /** Shown at the right of the header, next to the chevron. */
  action?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="border-t border-sidebar-border/60 pt-3"
    >
      {/* The action sits over the trigger row rather than inside it: the
          trigger is a button, and a button cannot hold another. */}
      <div className="relative">
        <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 hover:text-foreground">
          <span>{title}</span>
          <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
        </CollapsibleTrigger>
        {action && (
          <div className="absolute right-5 top-1/2 -translate-y-1/2">
            {action}
          </div>
        )}
      </div>
      <CollapsibleContent className="pt-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/**
 * A section's "Reset", in words rather than a circular arrow, which read as
 * "refresh". `label` says what it resets, for screen readers and the tooltip.
 * Always shown, so it can be found before it is needed; disabled while the
 * section is already on its defaults.
 */
function ResetButton({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-foreground focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {t('chat:runSettings.reset')}
    </button>
  )
}

/**
 * The right-hand "Run settings" panel: which assistant answers, how much
 * context the local model loads with (plus its other load-time options), and
 * the assistant's sampling. Sampling and the assistant persist through the
 * assistant store; model settings through the provider store, restarting a
 * loaded model when needed.
 */
export function RunSettingsPanel({ onClose }: RunSettingsPanelProps) {
  const { t } = useTranslation()
  const {
    assistants,
    activeAssistant,
    selectAssistant,
    updateParam,
    updateInstructions,
  } = useEffectiveAssistant()
  const addAssistant = useAssistant((state) => state.addAssistant)
  const updateAssistant = useAssistant((state) => state.updateAssistant)
  const updateProvider = useModelProvider((state) => state.updateProvider)
  const serviceHub = useServiceHub()
  const context = useModelContextLength()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [createAssistantOpen, setCreateAssistantOpen] = useState(false)

  // A new assistant made from here is meant for the chat at hand, so it
  // becomes the active one straight away instead of only landing in Settings.
  const handleCreateAssistant = (assistant: Assistant) => {
    addAssistant(assistant)
    selectAssistant(assistant)
    setCreateAssistantOpen(false)
  }

  // Back to what a new assistant starts with, for when the sliders have been
  // dragged somewhere that no longer answers well. Sampling only: the
  // assistant, its prompt and the model's load options stay as they are.
  const canResetSampling = activeAssistant
    ? hasCustomSampling(activeAssistant)
    : false
  const handleResetSampling = () => {
    if (!activeAssistant) return
    updateAssistant({
      ...activeAssistant,
      parameters: withDefaultSampling(activeAssistant.parameters),
      sampling_overridden: false,
    })
  }

  // Back to the load options a newly listed model starts with. Model only:
  // sampling stays as it is. With `--fit` on the engine sizes the context
  // itself, so that value is not the user's to reset.
  const customModelKeys = customModelSettingKeys(
    context.selectedModel?.settings
  ).filter((key) => !(context.fitEnabled && key === 'ctx_len'))
  const handleResetModel = () => {
    const { provider, selectedModel } = context
    if (!provider || !selectedModel || customModelKeys.length === 0) return
    updateProvider(provider.provider, {
      models: provider.models.map((model) =>
        model.id === selectedModel.id
          ? {
              ...model,
              settings: withDefaultModelSettings(
                model.settings,
                customModelKeys
              ),
            }
          : model
      ),
    })

    if (!customModelKeys.some((key) => RESTART_REQUIRED_SETTINGS.has(key))) {
      return
    }
    serviceHub
      .models()
      .getActiveModels(provider.provider)
      .then((activeModels) =>
        activeModels.includes(selectedModel.id)
          ? restartLocalModel(serviceHub, provider.provider, selectedModel.id)
          : undefined
      )
      .catch((error) => {
        console.error('Failed to restart model after settings reset:', error)
      })
  }

  const closeLabel = t('chat:runSettings.close')

  return (
    <div className="h-full p-2 pl-0">
      <aside className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-clip-padding bg-linear-to-b from-sidebar to-background text-sidebar-foreground shadow dark:from-sidebar/70">
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
          <div className="space-y-2">
            <div className="flex h-8 items-center justify-between gap-2">
              <h2 className="min-w-0 truncate text-sm font-medium">
                {t('chat:runSettings.title')}
              </h2>
              <button
                type="button"
                className={HEADER_ICON_BUTTON}
                aria-label={closeLabel}
                title={closeLabel}
                onClick={onClose}
              >
                <PanelRight className="size-4" />
              </button>
            </div>
            {/* In words, and on its own row: a circular-arrow icon here read
                as "refresh", and the label does not fit beside the title. */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full border-secondary bg-secondary/30 text-xs"
              disabled={!canResetSampling}
              onClick={handleResetSampling}
            >
              {t('chat:runSettings.resetSampling')}
            </Button>
          </div>

          {/* Assistant: whose persona and sampling this chat uses. */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t('assistants:title')}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-full justify-between gap-2 border-secondary bg-secondary/30"
                >
                  <span className="flex items-center gap-2 truncate">
                    {activeAssistant ? (
                      <AvatarEmoji
                        avatar={activeAssistant.avatar}
                        imageClassName="size-4 object-contain"
                        textClassName="text-sm"
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    <span className="truncate">
                      {activeAssistant?.name ?? t('assistants:none')}
                    </span>
                  </span>
                  <IconChevronDown
                    size={14}
                    className="text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-(--radix-dropdown-menu-trigger-width) max-h-64 overflow-y-auto"
              >
                <DropdownMenuItem
                  className={!activeAssistant ? 'bg-accent' : ''}
                  onClick={() => selectAssistant(undefined)}
                >
                  <span className="text-muted-foreground">—</span>
                  <span>{t('assistants:none')}</span>
                </DropdownMenuItem>
                {assistants.length > 0 ? (
                  assistants.map((assistant) => (
                    <DropdownMenuItem
                      key={assistant.id}
                      className={
                        activeAssistant?.id === assistant.id ? 'bg-accent' : ''
                      }
                      onClick={() => selectAssistant(assistant)}
                    >
                      <AvatarEmoji
                        avatar={assistant.avatar}
                        imageClassName="size-4 object-contain"
                        textClassName="text-sm"
                      />
                      <span className="truncate">
                        {assistant.name || t('assistants:none')}
                      </span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>
                    <span className="text-muted-foreground">
                      {t('assistants:noAssistants')}
                    </span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setCreateAssistantOpen(true)}>
                  <IconCirclePlus size={14} className="text-muted-foreground" />
                  <span>{t('assistants:addAssistant')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <AddEditAssistant
              open={createAssistantOpen}
              onOpenChange={setCreateAssistantOpen}
              editingKey={null}
              onSave={handleCreateAssistant}
            />
          </div>

          {/* System prompt of the active assistant; the next message sends it. */}
          <div className="space-y-1.5">
            <label
              htmlFor="run-settings-system-prompt"
              className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70"
            >
              {t('assistants:instructions')}
            </label>
            <Textarea
              id="run-settings-system-prompt"
              value={activeAssistant?.instructions ?? ''}
              onChange={(event) => updateInstructions(event.target.value)}
              placeholder={t('assistants:enterInstructions')}
              disabled={!activeAssistant}
              className="max-h-48 min-h-20 resize-none border-secondary bg-secondary/30 px-2.5 py-1.5 text-xs md:text-xs"
            />
            <p className="text-xs leading-normal text-muted-foreground">
              {t('assistants:instructionsDateHint')}
            </p>
          </div>

          {/* Model: only local engines expose a context knob and load options. */}
          {context.available &&
            context.contextSetting &&
            context.provider &&
            context.selectedModel && (
              <Section
                title={t('chat:runSettings.model')}
                action={
                  <ResetButton
                    label={t('chat:runSettings.resetModel')}
                    disabled={customModelKeys.length === 0}
                    onClick={handleResetModel}
                  />
                }
              >
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-muted-foreground">
                        {t('assistants:contextSize')}
                      </span>
                      <span className="font-mono text-xs tabular-nums">
                        {formatContextSize(context.draft)}
                      </span>
                    </div>
                    {context.fitAvailable && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-muted-foreground">
                          {t('assistants:contextSizeFit')}
                        </span>
                        <Switch
                          aria-label={t('assistants:contextSizeFit')}
                          checked={context.fitEnabled}
                          onCheckedChange={context.setFit}
                        />
                      </div>
                    )}
                    <Slider
                      aria-label={t('assistants:contextSize')}
                      className="w-full"
                      disabled={context.fitEnabled}
                      value={[
                        Math.min(
                          Math.max(context.draft, context.sliderMin),
                          context.sliderMax
                        ),
                      ]}
                      min={context.sliderMin}
                      max={context.sliderMax}
                      step={context.sliderStep}
                      onValueChange={([value]) => context.setDraft(value)}
                      onValueCommit={([value]) => context.commit(value)}
                    />
                    <p className="text-xs leading-normal text-muted-foreground">
                      {context.fitEnabled
                        ? t('assistants:contextSizeFitOn')
                        : t('assistants:contextSizeHint')}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-muted-foreground">
                        {t('chat:runSettings.advancedSettings')}
                      </div>
                      <p className="text-xs leading-normal text-muted-foreground/70">
                        {t('chat:runSettings.advancedSettingsHint')}
                      </p>
                    </div>
                    <Switch
                      aria-label={t('chat:runSettings.advancedSettings')}
                      checked={advancedOpen}
                      onCheckedChange={setAdvancedOpen}
                    />
                  </div>
                  {advancedOpen && (
                    <ModelSettingsList
                      model={context.selectedModel}
                      provider={context.provider}
                      excludeKeys={['ctx_len', 'auto_increase_ctx_len']}
                      className="space-y-5 text-sm"
                    />
                  )}
                </div>
              </Section>
            )}

          {/* Sampling of the active assistant. */}
          <Section title={t('assistants:paramCategory.sampling')}>
            <ParametersSection
              parameters={activeAssistant?.parameters ?? {}}
              onChange={updateParam}
              paramKeys={RUN_SETTINGS_SAMPLING_KEYS}
              className={cn(
                '[&>div:first-child>div:first-child]:hidden',
                !activeAssistant && 'pointer-events-none opacity-50'
              )}
            />
          </Section>
        </div>
      </aside>
    </div>
  )
}
