import { IconCheck, IconCopy } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { copyToClipboard } from '@/lib/clipboard'
import { generateLocalApiKey } from '@/lib/localApiKey'
import { cn } from '@/lib/utils'

import './ServerPage.css'

/**
 * A page of the Server section: one scrolling column with the prototype's
 * title block. The window title bar above already carries the drag region,
 * so these pages have no header row of their own. Overview has no title.
 * `wide` is for a dashboard built from the app's own components: it gets the
 * title block and the width, but its content keeps the app's styles rather
 * than the section's.
 */
export function ServerPage({
  title,
  description,
  actions,
  wide = false,
  children,
}: {
  title?: string
  description?: string
  /** Page-level actions, right of the title. */
  actions?: ReactNode
  wide?: boolean
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
        {wide ? (
          <div className="w-full max-w-[1200px]">
            <div className="server-page server-page-wide">{heading}</div>
            {children}
          </div>
        ) : (
          <div className="server-page">
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
