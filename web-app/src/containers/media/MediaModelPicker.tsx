/**
 * The Media page's model picker (the user, 2026-09-15: "same as the chat model
 * picker", saying what is downloaded and in which sizes).
 *
 * A model offered in several sizes (quantisations) is listed once, under its
 * name, with each size beneath it smallest first. The panel beside the list
 * says what the highlighted size downloads, file by file, and roughly how
 * much memory it needs, before anything is downloaded.
 */

import { useMemo, useState } from 'react'
import { IconCheck, IconChevronDown, IconSearch } from '@tabler/icons-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { MediaModelDescriptor } from '@/services/media/contract'

import { formatDownloadSize } from './downloadSize'
import { fieldClass } from './params/paramIdentity'

type MediaModelPickerProps = {
  /** The id the "Model" caption points at. */
  id: string
  ariaLabel: string
  models: MediaModelDescriptor[]
  selectedId: string
  onSelect: (modelId: string) => void
  disabled?: boolean
}

type ModelGroup = {
  id: string
  label: string
  models: MediaModelDescriptor[]
}

const ROLE_LABELS: Record<string, string> = {
  model: 'Model',
  diffusion_model: 'Diffusion model',
  vae: 'VAE (turns the result into pixels)',
  clip_l: 'CLIP text encoder',
  t5xxl: 'Text encoder',
}

function groupModels(models: MediaModelDescriptor[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>()
  for (const model of models) {
    const key = model.quant ? `${model.provider_id}:${model.quant.group_id}` : model.id
    const group = groups.get(key) ?? {
      id: key,
      label: model.quant?.group_label ?? model.label,
      models: [],
    }
    group.models.push(model)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.models.sort(
      (a, b) => (a.install?.size_bytes ?? 0) - (b.install?.size_bytes ?? 0)
    )
  }
  return [...groups.values()]
}

function matches(group: ModelGroup, model: MediaModelDescriptor, query: string): boolean {
  const haystack = [group.label, model.label, model.quant?.label, model.family]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

function formatMemory(mb: number): string {
  const gb = mb / 1024
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`
}

function InstallBadge({ model }: { model: MediaModelDescriptor }) {
  const { t } = useTranslation()
  if (!model.install?.installable) return null
  return model.install.installed ? (
    <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
      {t('media:picker.downloaded', { defaultValue: 'Downloaded' })}
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      {t('media:picker.notDownloaded', { defaultValue: 'Not downloaded' })}
    </span>
  )
}

function QuantChip({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded border border-border/70 px-1 font-mono text-[11px] text-foreground">
      {label}
    </span>
  )
}

function ModelDetails({ model }: { model: MediaModelDescriptor | null }) {
  const { t } = useTranslation()
  if (!model) return null
  const size = formatDownloadSize(model.install?.size_bytes)
  const files = model.download_files ?? []
  return (
    <div
      className="border-t border-border/60 p-3 text-sm sm:border-t-0 sm:border-l"
      data-testid="media-model-details"
    >
      <p className="font-medium text-foreground">
        {model.quant?.group_label ?? model.label}
      </p>
      {model.quant ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {model.quant.label}
          {model.quant.note ? ` — ${model.quant.note}` : ''}
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {size ? (
          <>
            <dt className="text-muted-foreground">
              {t('media:picker.download', { defaultValue: 'Download' })}
            </dt>
            <dd className="tabular-nums">{size}</dd>
          </>
        ) : null}
        {model.min_memory_mb ? (
          <>
            <dt className="text-muted-foreground">
              {t('media:picker.memory', { defaultValue: 'Memory' })}
            </dt>
            <dd>
              {t('media:picker.memoryNeeded', {
                amount: formatMemory(model.min_memory_mb),
                defaultValue: 'About {{amount}} of graphics memory',
              })}
            </dd>
          </>
        ) : null}
        {model.license?.id ? (
          <>
            <dt className="text-muted-foreground">
              {t('media:picker.licence', { defaultValue: 'Licence' })}
            </dt>
            <dd className="truncate">{model.license.id}</dd>
          </>
        ) : null}
        {model.install?.installable ? (
          <>
            <dt className="text-muted-foreground">
              {t('media:picker.status', { defaultValue: 'Status' })}
            </dt>
            <dd>
              {model.install.installed
                ? t('media:picker.downloaded', { defaultValue: 'Downloaded' })
                : t('media:picker.notDownloadedYet', {
                    defaultValue: 'Not downloaded yet',
                  })}
            </dd>
          </>
        ) : null}
      </dl>

      {files.length ? (
        <>
          <p className="mt-3 mb-1 text-xs font-medium text-muted-foreground">
            {t('media:picker.files', { defaultValue: 'What gets downloaded' })}
          </p>
          <ul className="space-y-1.5">
            {files.map((file) => (
              <li
                key={file.name}
                className="rounded-md bg-secondary/30 px-2 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono" title={file.name}>
                    {file.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatDownloadSize(file.size_bytes)}
                  </span>
                  {file.installed ? (
                    <IconCheck
                      size={12}
                      aria-label={t('media:picker.downloaded', { defaultValue: 'Downloaded' })}
                      className="shrink-0 text-emerald-500"
                    />
                  ) : null}
                </div>
                <div className="mt-0.5 truncate text-muted-foreground">
                  {ROLE_LABELS[file.role] ?? file.role}
                  {file.source ? ` · ${file.source}` : ''}
                </div>
              </li>
            ))}
          </ul>
          {files.length > 1 ? (
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
              {t('media:picker.sharedParts', {
                defaultValue:
                  'Parts every size of this model shares are downloaded once.',
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export function MediaModelPicker({
  id,
  ariaLabel,
  models,
  selectedId,
  onSelect,
  disabled,
}: MediaModelPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightId, setHighlightId] = useState<string | null>(null)

  const selected = models.find((model) => model.id === selectedId) ?? null
  const groups = useMemo(() => groupModels(models), [models])
  const shown = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          models: group.models.filter((model) => matches(group, model, query)),
        }))
        .filter((group) => group.models.length > 0),
    [groups, query]
  )
  const highlighted = models.find((model) => model.id === highlightId) ?? selected

  const choose = (modelId: string) => {
    onSelect(modelId)
    setOpen(false)
    setQuery('')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setHighlightId(selectedId || null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(fieldClass, 'flex items-center gap-2 text-left')}
        >
          <span className="min-w-0 flex-1 truncate">
            {selected
              ? (selected.quant?.group_label ?? selected.label)
              : t('media:picker.choose', { defaultValue: 'Choose a model' })}
          </span>
          {selected?.quant ? <QuantChip label={selected.quant.label} /> : null}
          {selected ? <InstallBadge model={selected} /> : null}
          <IconChevronDown size={14} className="shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(44rem,calc(100vw-2rem))] p-0"
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <IconSearch size={14} className="shrink-0 text-muted-foreground" />
          <input
            type="search"
            aria-label={t('media:picker.search', { defaultValue: 'Search models' })}
            placeholder={t('media:picker.search', { defaultValue: 'Search models' })}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <div className="grid sm:grid-cols-2">
          <div
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-96 overflow-y-auto p-1.5"
          >
            {shown.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                {t('media:picker.noMatches', { defaultValue: 'No models match' })}
              </p>
            ) : (
              shown.map((group) => (
                <div
                  key={group.id}
                  role="group"
                  aria-label={group.label}
                  className="my-1 rounded-sm bg-secondary/30 py-1 first:mt-0"
                >
                  <div className="flex items-center justify-between gap-2 px-2 py-1">
                    <span className="truncate text-sm font-medium text-muted-foreground">
                      {group.label}
                    </span>
                    {group.models.length > 1 ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {t('media:picker.sizes', {
                          count: group.models.length,
                          defaultValue: '{{count}} sizes',
                        })}
                      </span>
                    ) : null}
                  </div>
                  {group.models.map((model) => {
                    const isSelected = model.id === selectedId
                    const size = formatDownloadSize(model.install?.size_bytes)
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        aria-label={model.label}
                        onClick={() => choose(model.id)}
                        onMouseEnter={() => setHighlightId(model.id)}
                        onFocus={() => setHighlightId(model.id)}
                        className={cn(
                          'mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-200 hover:bg-secondary/40',
                          isSelected && 'bg-secondary/50'
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            {model.quant ? (
                              <QuantChip label={model.quant.label} />
                            ) : (
                              <span className="truncate">{model.label}</span>
                            )}
                            {model.quant?.is_default ? (
                              <span className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-px text-[10px] font-medium text-sky-600 dark:text-sky-400">
                                {t('media:picker.recommended', {
                                  defaultValue: 'Recommended',
                                })}
                              </span>
                            ) : null}
                            <InstallBadge model={model} />
                          </span>
                          {model.quant?.note ? (
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {model.quant.note}
                            </span>
                          ) : null}
                        </span>
                        {size ? (
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {size}
                          </span>
                        ) : null}
                        {isSelected ? <IconCheck size={14} className="shrink-0" /> : null}
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
          <ModelDetails model={highlighted} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
