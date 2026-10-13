import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { IconCopy, IconPlus, IconRestore, IconTrash } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { promptVariables } from '@/lib/promptVariables'
import { cn } from '@/lib/utils'
import {
  useSavedPrompts,
  type PromptCategory,
  type SavedPrompt,
} from '@/stores/saved-prompts-store'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.prompts as any)({
  component: PromptsSettings,
})

type Filter = 'all' | PromptCategory

function PromptRow({
  prompt,
  selected,
  onSelect,
}: {
  prompt: SavedPrompt
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="prompt-row"
      data-no-hover-glow
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-secondary',
        selected && 'bg-foreground/10 ring-1 ring-foreground/20'
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className="truncate">{prompt.title}</span>
        {prompt.category === 'agent' && (
          <span className="rounded-md border px-1 font-mono text-[10px] text-primary">
            {t('settings:prompts.agentTag', { defaultValue: 'agent' })}
          </span>
        )}
        {!prompt.showInComposer && (
          <span className="text-[10px] text-muted-foreground">
            {t('settings:prompts.hidden', { defaultValue: 'hidden' })}
          </span>
        )}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {prompt.description || prompt.body}
      </span>
    </button>
  )
}

function PromptEditor({ prompt }: { prompt: SavedPrompt }) {
  const { t } = useTranslation()
  const update = useSavedPrompts((state) => state.update)
  const remove = useSavedPrompts((state) => state.remove)
  const duplicate = useSavedPrompts((state) => state.duplicate)
  const variables = useMemo(() => promptVariables(prompt.body), [prompt.body])

  // Edits are saved as they are typed, because the composer's pill reads the
  // same list and should never show something older than this screen.
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="prompt-editor">
      <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('settings:prompts.title', { defaultValue: 'Title' })}
          <Input
            value={prompt.title}
            onChange={(event) => update(prompt.id, { title: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('settings:prompts.type', { defaultValue: 'Type' })}
          <select
            className="border-input h-9 rounded-md border bg-transparent px-2 text-sm text-foreground"
            value={prompt.category}
            onChange={(event) =>
              update(prompt.id, { category: event.target.value as PromptCategory })
            }
          >
            <option value="agent">
              {t('settings:prompts.typeAgent', { defaultValue: 'Agent task' })}
            </option>
            <option value="chat">
              {t('settings:prompts.typeChat', { defaultValue: 'Basic prompt' })}
            </option>
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t('settings:prompts.description', { defaultValue: 'Short description' })}
        <Input
          value={prompt.description}
          onChange={(event) =>
            update(prompt.id, { description: event.target.value })
          }
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t('settings:prompts.body', { defaultValue: 'Prompt' })}
        <Textarea
          value={prompt.body}
          onChange={(event) => update(prompt.id, { body: event.target.value })}
          className="min-h-48 resize-y font-mono text-xs leading-relaxed"
        />
      </label>

      {variables.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('settings:prompts.variables', {
            defaultValue: 'Fill in when you use it:',
          })}{' '}
          {variables.map((name) => (
            <code key={name} className="mr-1 rounded bg-muted px-1 font-mono">
              {`{{${name}}}`}
            </code>
          ))}
        </p>
      )}

      <div className="flex items-center gap-3 text-sm">
        <Switch
          checked={prompt.showInComposer}
          onCheckedChange={(checked) =>
            update(prompt.id, { showInComposer: checked })
          }
          aria-label={t('settings:prompts.showInComposer', {
            defaultValue: 'Show in composer',
          })}
        />
        <span>
          {t('settings:prompts.showInComposer', { defaultValue: 'Show in composer' })}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => duplicate(prompt.id)}
        >
          <IconCopy size={14} />
          {t('settings:prompts.duplicate', { defaultValue: 'Duplicate' })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => remove(prompt.id)}
        >
          <IconTrash size={14} />
          {t('settings:prompts.delete', { defaultValue: 'Delete' })}
        </Button>
      </div>
    </div>
  )
}

export function PromptsSettings() {
  const { t } = useTranslation()
  const prompts = useSavedPrompts((state) => state.prompts)
  const add = useSavedPrompts((state) => state.add)
  const restoreStarters = useSavedPrompts((state) => state.restoreStarters)
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const visible = prompts.filter(
    (prompt) => filter === 'all' || prompt.category === filter
  )
  const selected =
    prompts.find((prompt) => prompt.id === selectedId) ?? visible[0] ?? null

  const filters: Array<{ key: Filter; label: string }> = [
    { key: 'all', label: t('settings:prompts.all', { defaultValue: 'All' }) },
    { key: 'agent', label: t('settings:prompts.agent', { defaultValue: 'Agent' }) },
    { key: 'chat', label: t('settings:prompts.basic', { defaultValue: 'Basic' }) },
  ]

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <div className="flex w-full items-center gap-2">
          <span className="font-studio text-base font-medium">
            {t('common:settings')}
          </span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="w-full overflow-y-auto p-4 pt-0">
          <div className="mb-3">
            <h1 className="text-lg font-medium">
              {t('common:prompts', { defaultValue: 'Prompts' })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('settings:prompts.intro', {
                defaultValue:
                  'Saved prompts for the Prompts pill in the chat box, including the jobs an agent does all the time. Changes apply straight away.',
              })}
            </p>
          </div>

          <div className="grid min-h-[28rem] gap-4 lg:grid-cols-[18rem_1fr]">
            <section className="flex min-h-0 flex-col gap-2 rounded-2xl border p-2">
              <div className="flex items-center justify-between gap-2 px-1 pt-1">
                <div className="flex gap-1">
                  {filters.map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      data-no-hover-glow
                      onClick={() => setFilter(key)}
                      aria-pressed={filter === key}
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground',
                        filter === key && 'bg-foreground/10 text-foreground'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setFilter('all')
                    setSelectedId(add())
                  }}
                >
                  <IconPlus size={14} />
                  {t('settings:prompts.new', { defaultValue: 'New' })}
                </Button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
                {visible.map((prompt) => (
                  <PromptRow
                    key={prompt.id}
                    prompt={prompt}
                    selected={prompt.id === selected?.id}
                    onSelect={() => setSelectedId(prompt.id)}
                  />
                ))}
                {visible.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">
                    {t('settings:prompts.empty', {
                      defaultValue: 'No prompts here yet.',
                    })}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start text-muted-foreground"
                onClick={restoreStarters}
              >
                <IconRestore size={14} />
                {t('settings:prompts.restore', {
                  defaultValue: 'Restore the starter prompts',
                })}
              </Button>
            </section>

            <section className="min-w-0 rounded-2xl border p-4">
              {selected ? (
                <PromptEditor key={selected.id} prompt={selected} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('settings:prompts.pick', {
                    defaultValue: 'Select a prompt to edit it, or add a new one.',
                  })}
                </p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
