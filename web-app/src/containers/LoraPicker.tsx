import { useEffect, useId, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import {
  loras,
  loraError,
  useLoraInventoryVersion,
  type LoraChoices,
  type LoraMode,
} from '@/services/loras'
export function LoraPicker({
  model,
  mode,
  disabled = false,
}: {
  model: string
  mode: LoraMode
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const id = useId()
  const version = useLoraInventoryVersion((s) => s.version)
  const [choices, setChoices] = useState<LoraChoices>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  useEffect(() => {
    let active = true
    loras
      .choices(mode, model)
      .then((v) => {
        if (active) {
          setChoices(v)
          setError('')
        }
      })
      .catch((e) => {
        if (active) setError(loraError(e))
      })
    return () => {
      active = false
    }
  }, [mode, model, version, attempt])
  async function select(value: string) {
    if (!choices || busy) return
    setBusy(true)
    setError('')
    try {
      await loras.select(mode, model, value || null)
      setChoices({ ...choices, adapterId: value || null })
    } catch (e) {
      setError(loraError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <label htmlFor={id} className="text-sm text-muted-foreground">
          LoRA
        </label>
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 text-xs"
          onClick={() =>
            void navigate({
              to: route.hub.index,
              search: { category: 'loras', target: choices?.target },
            })
          }
        >
          {t('hub:loras.find')}
        </Button>
      </div>
      <select
        id={id}
        className="h-8 w-full min-w-0 truncate rounded-md border border-input bg-background px-2 text-sm"
        disabled={disabled || busy || !choices?.files.length}
        value={choices?.adapterId ?? ''}
        onChange={(e) => void select(e.target.value)}
      >
        <option value="">
          {t(choices || error ? 'hub:loras.none' : 'common:loading')}
        </option>
        {choices?.files.map((row) => (
          <option key={row.sha256} value={row.sha256}>
            {row.repo} · {row.file}
          </option>
        ))}
      </select>
      {busy && (
        <p role="status" className="text-xs">
          {t('hub:drafters.applying')}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}{' '}
          <Button variant="link" size="sm" onClick={() => retry((n) => n + 1)}>
            {t('hub:drafters.retry')}
          </Button>
        </p>
      )}
    </div>
  )
}
