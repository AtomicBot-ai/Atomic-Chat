import { useEffect, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'

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
import { LocalModelCollisionNotice } from '@/containers/endpoints/LocalModelCollisionNotice'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { takesApiKey } from '@/lib/cloud-providers'
import { ownLocalApiServerUrl } from '@/lib/local-api-self-reference'
import { getProviderTitle } from '@/lib/utils'

export type EndpointDraft = {
  name: string
  baseUrl: string
  apiKey: string
  /** Save even though the server called the key invalid. */
  saveAnyway?: boolean
}

/** Why a draft was not saved, and whether the user may save it anyway. */
export type EndpointSaveRefusal = {
  message: string
  /** The server called the key invalid, which a gateway can do wrongly. */
  canSaveAnyway?: boolean
}

type EndpointDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The endpoint being configured; absent when adding one. */
  provider?: ProviderObject
  /** Every provider name in use, to refuse a second one with the same name. */
  takenNames: string[]
  /**
   * Save the draft. Resolves to why it was refused — the dialog then stays
   * open and says so — or to nothing once it is saved.
   */
  onSave: (
    draft: EndpointDraft
  ) => Promise<EndpointSaveRefusal | undefined> | void
}

/** The draft as it would be saved, to tell whether it changed since a refusal. */
const draftKey = (draft: EndpointDraft) =>
  JSON.stringify([draft.name.trim(), draft.baseUrl.trim(), draft.apiKey.trim()])

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
  // The address and key are checked before the endpoint is saved.
  const [saving, setSaving] = useState(false)
  // The draft whose key the server called invalid: it may be saved anyway
  // for as long as it is left as it was.
  const [refusedDraft, setRefusedDraft] = useState<string | null>(null)

  // Every opening starts from the endpoint as it is stored now. Only opening
  // resets it: a store write while the dialog is open (a model reload
  // finishing) must not wipe what the user is typing.
  useEffect(() => {
    if (!open) return
    setError('')
    setSaving(false)
    setRefusedDraft(null)
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

  const submit = async (event: FormEvent | undefined, saveAnyway = false) => {
    event?.preventDefault()
    if (saving) return
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
    // Every remote request goes through the app's own Local API Server, so an
    // endpoint pointing at it would only ever reach itself.
    const ownServer = ownLocalApiServerUrl(baseUrl)
    if (ownServer) {
      setError(t('endpoints:dialog.ownServer', { url: ownServer }))
      return
    }
    setError('')
    setRefusedDraft(null)
    setSaving(true)
    try {
      const refused = await onSave({
        name,
        baseUrl,
        apiKey: draft.apiKey.trim(),
        saveAnyway: saveAnyway && refusedDraft === draftKey(draft),
      })
      if (refused) {
        setError(refused.message)
        if (refused.canSaveAnyway) setRefusedDraft(draftKey(draft))
      }
    } finally {
      setSaving(false)
    }
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
        <form
          onSubmit={(event) => void submit(event)}
          className="min-w-0 space-y-4"
          noValidate
        >
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
          {provider && (
            <LocalModelCollisionNotice
              endpoint={provider.provider}
              modelIds={(provider.models ?? []).map((m) => m.id)}
            />
          )}
          {error && (
            <p role="alert" className="text-sm break-words text-destructive">
              {error}
            </p>
          )}
          {error && refusedDraft === draftKey(draft) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => void submit(undefined, true)}
            >
              {t('endpoints:dialog.saveAnyway')}
            </Button>
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
              disabled={saving || !draft.name.trim() || !draft.baseUrl.trim()}
            >
              {saving && (
                <Loader2 size={14} className="animate-spin" aria-hidden />
              )}
              {saving
                ? t('endpoints:dialog.checking')
                : t('endpoints:dialog.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
