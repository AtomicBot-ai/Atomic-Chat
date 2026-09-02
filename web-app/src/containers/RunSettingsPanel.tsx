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
import { useTranslation } from '@/i18n/react-i18next-compat'
import { paramGroups } from '@/lib/predefinedParams'
import { cn } from '@/lib/utils'

type RunSettingsPanelProps = {
  onClose: () => void
}

const SAMPLING_KEYS = [...paramGroups.sampling, ...paramGroups.penalties]

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="border-t border-sidebar-border/60 pt-3"
    >
      <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 hover:text-foreground">
        <span>{title}</span>
        <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">{children}</CollapsibleContent>
    </Collapsible>
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
  const { assistants, activeAssistant, selectAssistant, updateParam } =
    useEffectiveAssistant()
  const addAssistant = useAssistant((state) => state.addAssistant)
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

  const closeLabel = t('chat:runSettings.close')

  return (
    <div className="h-full p-2 pl-0">
      <aside className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-clip-padding bg-linear-to-b from-sidebar to-background text-sidebar-foreground shadow dark:from-sidebar/70">
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
          <div className="flex h-8 items-center justify-between">
            <h2 className="text-sm font-medium">
              {t('chat:runSettings.title')}
            </h2>
            <button
              type="button"
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-foreground focus-visible:ring-2"
              aria-label={closeLabel}
              title={closeLabel}
              onClick={onClose}
            >
              <PanelRight className="size-4" />
            </button>
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

          {/* Model: only local engines expose a context knob and load options. */}
          {context.available &&
            context.contextSetting &&
            context.provider &&
            context.selectedModel && (
              <Section title={t('chat:runSettings.model')}>
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
                    <Slider
                      aria-label={t('assistants:contextSize')}
                      className="w-full"
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
                      {t('assistants:contextSizeHint')}
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
              paramKeys={SAMPLING_KEYS}
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
