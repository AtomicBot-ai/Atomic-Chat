import { memo, useId, useState, type ComponentType } from 'react'
import { IconCheck, IconChevronDown, type IconProps } from '@tabler/icons-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ImageField } from './ImageField'

export type MediaMode<Id extends string> = {
  id: Id
  icon: ComponentType<IconProps>
  title: string
  hint: string
  /** Listed but not selectable yet; `badge` says why. */
  disabled?: boolean
  badge?: string
}

type MediaModeSelectProps<Id extends string> = {
  modes: readonly MediaMode<Id>[]
  value: Id
  onChange: (id: Id) => void
  /** The field label over the pill, e.g. "Mode"; also names the pill. */
  label: string
  /** `image` or `video`: prefixes the test ids. */
  testIdPrefix: string
  /**
   * The pill alone, for a toolbar: the label is kept for screen readers only
   * (it still names the pill), so the pill lines up with the controls beside it.
   */
  compact?: boolean
}

/**
 * The mode picker of the Images and Video form columns, under the page
 * heading: a labelled field whose select pill shows the active mode's icon
 * and title, and opens the list of the page's modes with their hints. Both pages use it, so a mode
 * is always picked in the same place — the sidebar only names the section.
 */
function MediaModeSelectInner<Id extends string>({
  modes,
  value,
  onChange,
  label,
  testIdPrefix,
  compact = false,
}: MediaModeSelectProps<Id>) {
  const [open, setOpen] = useState(false)
  const active = modes.find((mode) => mode.id === value) ?? modes[0]
  const ActiveIcon = active.icon
  const labelId = useId()
  const titleId = useId()

  return (
    <ImageField
      label={<span id={labelId}>{label}</span>}
      className={compact ? 'gap-0 [&>div:first-child]:sr-only' : undefined}
    >
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-full border border-input bg-background px-3.5 text-left text-sm font-medium shadow-xs outline-none transition-colors duration-150 ease-out hover:bg-secondary/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-secondary/60 dark:border-input dark:bg-input/30"
            aria-labelledby={`${labelId} ${titleId}`}
            data-mode={active.id}
            data-testid={`${testIdPrefix}-workflow-select`}
          >
            <ActiveIcon size={16} className="shrink-0 text-foreground/70" />
            <span
              id={titleId}
              className="min-w-0 flex-1 truncate"
              data-testid={`${testIdPrefix}-workflow-title`}
            >
              {active.title}
            </span>
            <IconChevronDown
              size={16}
              className={cn(
                'shrink-0 text-muted-foreground transition-transform duration-200 ease-out',
                open && 'rotate-180'
              )}
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="w-(--radix-dropdown-menu-trigger-width) min-w-[260px] max-w-[calc(100vw-2rem)] rounded-xl bg-background/95 p-1.5 shadow-xl backdrop-blur-2xl"
          data-testid={`${testIdPrefix}-workflow-menu`}
        >
          {modes.map((mode) => {
            const Icon = mode.icon
            const selected = mode.id === active.id
            return (
              <DropdownMenuItem
                key={mode.id}
                disabled={mode.disabled}
                onSelect={() => {
                  if (!selected) onChange(mode.id)
                }}
                className="items-start gap-2.5 rounded-lg px-2 py-2"
                data-selected={selected}
                data-testid={`${testIdPrefix}-workflow-option-${mode.id}`}
              >
                <Icon size={16} className="mt-px shrink-0 text-foreground/70" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium leading-tight">
                    <span className="truncate">{mode.title}</span>
                    {mode.badge && (
                      <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {mode.badge}
                      </span>
                    )}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {mode.hint}
                  </span>
                </span>
                <IconCheck
                  size={16}
                  className={cn(
                    'mt-px shrink-0 text-foreground',
                    !selected && 'invisible'
                  )}
                />
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </ImageField>
  )
}

export const MediaModeSelect = memo(
  MediaModeSelectInner
) as typeof MediaModeSelectInner
