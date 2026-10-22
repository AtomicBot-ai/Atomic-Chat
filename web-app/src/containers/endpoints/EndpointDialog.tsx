import { useEffect, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { takesApiKey } from '@/lib/cloud-providers'
import { getProviderTitle } from '@/lib/utils'

export type EndpointDraft = {
  name: string
  baseUrl: string
  apiKey: string
}

type EndpointDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The endpoint being configured; absent when adding one. */
  provider?: ProviderObject
  /** Every provider name in use, to refuse a second one with the same name. */
  takenNames: string[]
  onSave: (draft: EndpointDraft) => void
}

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * Add or configure an endpoint: a name, the server's base URL and an optional
 * key. Providers are keyed by name, so the name is fixed once the endpoint
 * exists.
 */
export function EndpointDialog({
  open,
  onOpenChange,
  provider,
  takenNames,
  onSave,
}: EndpointDialogProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<EndpointDraft>({
    name: '',
    baseUrl: '',
    apiKey: '',
  })
  const [error, setError] = useState('')

  // Every opening starts from the endpoint as it is stored now. Only opening
  // resets it: a store write while the dialog is open (a model reload
  // finishing) must not wipe what the user is typing.
  useEffect(() => {
    if (!open) return
    setError('')
    setDraft({
      name: provider ? getProviderTitle(provider.provider) : '',
      baseUrl: provider?.base_url ?? '',
      apiKey: provider?.api_key ?? '',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider?.provider])

  // A server of one's own may want a key; a provider declaring no key
  // setting (none ships one today) is never asked for it.
  const showApiKey = !provider || takesApiKey(provider)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const name = draft.name.trim()
    const baseUrl = draft.baseUrl.trim()
    if (!provider) {
      if (!name) return
      if (
        takenNames.some((taken) => taken.toLowerCase() === name.toLowerCase())
      ) {
        setError(t('common:providerAlreadyExists', { name }))
        return
      }
    }
    if (!isHttpUrl(baseUrl)) {
      setError(t('endpoints:dialog.invalidUrl'))
      return
    }
    onSave({ name, baseUrl, apiKey: draft.apiKey.trim() })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {provider
              ? t('endpoints:dialog.configureTitle')
              : t('endpoints:dialog.addTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('endpoints:dialog.description')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="min-w-0 space-y-4" noValidate>
          <label className="block text-sm">
            {t('endpoints:dialog.name')}
            <Input
              required
              readOnly={Boolean(provider)}
              aria-describedby={provider ? 'endpoint-name-locked' : undefined}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={t('endpoints:dialog.namePlaceholder')}
              className="mt-1.5"
            />
            {provider && (
              <span
                id="endpoint-name-locked"
                className="mt-1 block text-xs text-muted-foreground"
              >
                {t('endpoints:dialog.nameLocked')}
              </span>
            )}
          </label>
          <label className="block text-sm">
            {t('endpoints:dialog.baseUrl')}
            <Input
              required
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder={
                (provider?.settings.find((s) => s.key === 'base-url')
                  ?.controller_props?.placeholder as string | undefined) ||
                t('endpoints:dialog.baseUrlPlaceholder')
              }
              className="mt-1.5"
            />
          </label>
          {showApiKey && (
            <label className="block text-sm">
              {t('endpoints:dialog.apiKey')}
              <Input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                autoComplete="off"
                className="mt-1.5"
              />
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm break-words text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t('endpoints:dialog.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!draft.name.trim() || !draft.baseUrl.trim()}
            >
              {t('endpoints:dialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
