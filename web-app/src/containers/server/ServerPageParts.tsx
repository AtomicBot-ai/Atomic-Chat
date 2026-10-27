import { IconCheck, IconCopy } from '@tabler/icons-react'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FamilyLogoMark } from '@/containers/ModelLogo'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { copyToClipboard } from '@/lib/clipboard'
import { generateLocalApiKey } from '@/lib/localApiKey'
import { cn } from '@/lib/utils'

import './ServerPage.css'

/**
 * A page of the Server section: one scrolling column with the prototype's
 * title block. The window title bar above already carries the drag region,
 * so these pages have no header row of their own. Overview has no title.
 * Every layout takes the whole page. `layout`: a `form`, a `wide` one
 * (Overview's cards), or a `dashboard` built from the app's own components,
 * which gets the title block but keeps the app's styles rather than the
 * section's.
 */
export function ServerPage({
  title,
  description,
  actions,
  layout = 'form',
  children,
}: {
  title?: string
  description?: string
  /** Page-level actions, right of the title. */
  actions?: ReactNode
  layout?: 'form' | 'wide' | 'dashboard'
  children: ReactNode
}) {
  const heading = title && (
    <div className="sp-section-title">
      <div className="min-w-0">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="sp-actions">{actions}</div>}
    </div>
  )

  return (
    <div className="flex h-svh w-full min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {layout === 'dashboard' ? (
          <div className="w-full">
            <div className="server-page server-page-wide">{heading}</div>
            {children}
          </div>
        ) : (
          <div
            className={cn(
              'server-page',
              layout === 'wide' && 'server-page-wide'
            )}
          >
            {heading}
            {children}
          </div>
        )}
      </div>
    </div>
  )
}

/** The section's pill button; `primary` is the filled one. */
export function ServerButton({
  primary = false,
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type={type}
      className={cn('sp-button', primary && 'sp-primary', className)}
      {...props}
    />
  )
}

/** A labelled form control with an optional hint under it. */
export function ServerField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  // The hint sits outside the label so it is not read as the control's name.
  return (
    <div className="sp-field">
      <label className="contents">
        <span>{label}</span>
        {children}
      </label>
      {hint && <small>{hint}</small>}
    </div>
  )
}

export type ServerSelectOption = { value: string; label: string }

/**
 * The section's dropdown. A native `<select>` opens the system menu, which in
 * the macOS webview sits over the field with the chosen row on it instead of
 * dropping down; this one always opens under the field, as wide as it.
 */
export function ServerSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: {
  /** The control's accessible name; the visible label stays the field's. */
  label: string
  value: string
  options: ServerSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={label}
          className={cn('sp-select', className)}
        >
          <span className="min-w-0 truncate">{selected?.label ?? value}</span>
          <ChevronDown aria-hidden size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) max-h-72"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span className="min-w-0 truncate">{option.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export type ServerDetailChoice = {
  value: string
  name: string
  /** A bundled mark (monochrome ones take the text colour); else its initial. */
  logo?: string
  /** What it is, in a line. */
  detail?: string
  /** Its facts ("GGUF · 2 models"), smaller still. */
  metadata?: string
}

function DetailChoiceRow({ choice }: { choice: ServerDetailChoice }) {
  return (
    <>
      {choice.logo ? (
        <FamilyLogoMark src={choice.logo} className="sp-picker-logo" />
      ) : (
        <span className="sp-picker-logo sp-picker-initial" aria-hidden>
          {choice.name.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="sp-picker-copy">
        <strong>{choice.name}</strong>
        {choice.detail && <span>{choice.detail}</span>}
        {choice.metadata && <small>{choice.metadata}</small>}
      </span>
    </>
  )
}

/**
 * A labelled dropdown whose choices need more than a name: the field and
 * every row of its menu show the same logo, name, line on what it is and its
 * facts, so the choice reads the same before and after it is made. Opens
 * under the field, as wide as it, like `ServerSelect`. Opens and closes on
 * its own unless `open` is given, for a page that opens it for the user (the
 * tray's Model and Runtime rows).
 */
export function ServerDetailPicker({
  label,
  value,
  choices,
  onChange,
  open,
  onOpenChange,
}: {
  label: string
  value: string
  choices: ServerDetailChoice[]
  onChange: (value: string) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const id = useId()
  const selected = choices.find((choice) => choice.value === value)
  return (
    <div className="sp-field">
      <span id={id}>{label}</span>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild disabled={choices.length === 0}>
          <button
            type="button"
            className="sp-detail-picker"
            aria-labelledby={id}
          >
            {selected ? (
              <DetailChoiceRow choice={selected} />
            ) : (
              <span className="sp-picker-copy">{value}</span>
            )}
            <ChevronDown aria-hidden size={18} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="start"
          aria-labelledby={id}
          // Utilities, so they win over the menu's own padding and corners.
          className="sp-picker-menu w-(--radix-dropdown-menu-trigger-width) max-w-[calc(100vw-32px)] rounded-xl p-1.5"
        >
          {choices.map((choice) => (
            <DropdownMenuItem
              key={choice.value}
              role="menuitemradio"
              aria-checked={choice.value === value}
              textValue={choice.name}
              className="sp-picker-option gap-3.5 rounded-lg p-3 aria-checked:bg-primary/10"
              onSelect={() => onChange(choice.value)}
            >
              <DetailChoiceRow choice={choice} />
              {choice.value === value && <Check aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** A titled row with one control on the right, separated by a rule. */
export function ServerSettingRow({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="sp-setting-row">
      <div className="min-w-0">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {children}
    </div>
  )
}

/** "Copy …" that turns into "Copied" once the text reached the clipboard. */
export function ServerCopyButton({
  value,
  label,
  onCopied,
}: {
  value: string
  label: string
  onCopied?: () => void
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <ServerButton
      onClick={async () => {
        if (!(await copyToClipboard(value))) return
        setCopied(true)
        onCopied?.()
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      {copied ? t('settings:serverKey.copied') : label}
    </ServerButton>
  )
}

/**
 * The Local API Server's key: masked, with Show/Hide once there is a key to
 * show, Generate and Copy. Controlled: the page decides when a value is kept.
 */
export function ServerApiKeyField({
  id,
  value,
  onChange,
  onBlur,
  onGenerate,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  /** Replaces the default, which fills in a fresh `sk-atomic-` key. */
  onGenerate?: () => void
}) {
  const { t } = useTranslation()
  const [reveal, setReveal] = useState(false)
  const hasKey = value.trim() !== ''

  return (
    <div className="sp-key-field">
      <label htmlFor={id}>{t('settings:serverKey.label')}</label>
      <div className="sp-key-controls">
        <input
          id={id}
          type={reveal && hasKey ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={t('settings:serverKey.placeholder')}
          onChange={(event) => {
            if (!event.target.value.trim()) setReveal(false)
            onChange(event.target.value)
          }}
          onBlur={onBlur}
        />
        {hasKey && (
          <ServerButton onClick={() => setReveal((shown) => !shown)}>
            {reveal
              ? t('settings:serverKey.hide')
              : t('settings:serverKey.show')}
          </ServerButton>
        )}
        <ServerButton
          onClick={() =>
            onGenerate ? onGenerate() : onChange(generateLocalApiKey())
          }
        >
          {t('settings:serverKey.generate')}
        </ServerButton>
        {hasKey && (
          <ServerCopyButton
            value={value}
            label={t('settings:serverKey.copy')}
          />
        )}
      </div>
    </div>
  )
}
