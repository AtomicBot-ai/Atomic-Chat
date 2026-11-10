import { useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardItem } from '@/containers/Card'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { accountErrorMessage, accountLabel } from '@/lib/account'
import { useAccountStore } from '@/stores/account-store'
import { toAccountError } from '@/services/account/errors'
import type {
  AccountIdentity,
  AccountProfile as AccountProfileData,
  AccountUser,
} from '@/services/account/types'
import { AccountAvatar } from './AccountAvatar'

const NAME_MAX = 100

function methodLabel(
  t: (key: string) => string,
  identity: AccountIdentity
): string {
  if (identity.provider === 'google') return t('account:profile.methodGoogle')
  if (identity.provider === 'email') return t('account:profile.methodEmail')
  return identity.provider
}

/**
 * Who is signed in: picture, display name (editable in place), email, the
 * ways the account can sign in, and signing out of this device.
 */
export function AccountProfile({
  user,
  profile,
  profileError,
  onProfileUpdated,
}: {
  user: AccountUser
  /** `null` until `account_profile` has answered. */
  profile: AccountProfileData | null
  /** Why `account_profile` failed, already worded. */
  profileError: string | null
  onProfileUpdated: (profile: AccountProfileData) => void
}) {
  const { t } = useTranslation()
  const account = useServiceHub().account()
  const setStatus = useAccountStore((state) => state.setStatus)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const startEditing = () => {
    setDraft(user.displayName ?? '')
    setNameError(null)
    setEditing(true)
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    const name = draft.trim()
    if (name.length < 1 || name.length > NAME_MAX) {
      setNameError(t('account:profile.displayNameLength'))
      return
    }
    setSaving(true)
    setNameError(null)
    try {
      onProfileUpdated(await account.updateProfile(name))
      setEditing(false)
    } catch (raw) {
      setNameError(
        accountErrorMessage(t, toAccountError(raw), {
          invalid_request: 'account:profile.displayNameLength',
        })
      )
    } finally {
      setSaving(false)
    }
  }

  const signOut = async () => {
    setSigningOut(true)
    setSignOutError(null)
    try {
      setStatus(await account.logout())
    } catch (raw) {
      setSignOutError(accountErrorMessage(t, toAccountError(raw)))
      setSigningOut(false)
    }
  }

  const identities = profile?.identities ?? []

  return (
    <Card title={t('account:profile.title')}>
      {/* Name and email are shown once, here; the name edits in place. */}
      <div className="mb-3 flex min-w-0 items-center gap-3 border-b border-border/40 pb-3">
        <AccountAvatar
          user={user}
          className="size-12"
          fallbackClassName="text-base"
        />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form className="flex flex-col gap-1.5" onSubmit={save} noValidate>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  aria-label={t('account:profile.displayName')}
                  value={draft}
                  maxLength={NAME_MAX}
                  autoFocus
                  aria-invalid={nameError !== null || undefined}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    if (nameError) setNameError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditing(false)
                  }}
                  disabled={saving}
                />
                <Button
                  type="submit"
                  size="sm"
                  className="shrink-0"
                  disabled={saving}
                >
                  {saving && <Loader2 className="animate-spin" />}
                  {t('account:profile.save')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  disabled={saving}
                  onClick={() => setEditing(false)}
                >
                  {t('account:profile.cancel')}
                </Button>
              </div>
              {nameError ? (
                <p role="alert" className="text-sm text-destructive">
                  {nameError}
                </p>
              ) : (
                <div className="truncate text-muted-foreground">
                  {user.email}
                </div>
              )}
            </form>
          ) : (
            <>
              <div
                className="truncate font-medium text-foreground"
                data-testid="account-name"
              >
                {accountLabel(user)}
              </div>
              <div className="truncate text-muted-foreground">
                {user.displayName?.trim()
                  ? user.email
                  : t('account:profile.displayNameEmpty')}
              </div>
            </>
          )}
        </div>
        {!editing && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={startEditing}
            aria-label={t('account:profile.editName')}
          >
            {t('account:profile.edit')}
          </Button>
        )}
      </div>

      <CardItem
        title={t('account:profile.methods')}
        description={
          profile ? (
            <span className="flex flex-wrap gap-1.5 pt-0.5">
              {identities.map((identity) => (
                <span
                  key={`${identity.provider}:${identity.email ?? ''}`}
                  className="inline-block max-w-full truncate rounded-full bg-foreground/8 px-2 py-0.5 text-xs font-medium text-foreground"
                  title={identity.email ?? undefined}
                >
                  {identity.email && identity.email !== user.email
                    ? `${methodLabel(t, identity)} · ${identity.email}`
                    : methodLabel(t, identity)}
                </span>
              ))}
            </span>
          ) : profileError ? (
            <span className="text-destructive">{profileError}</span>
          ) : (
            <span className="inline-block h-4 w-24 animate-pulse rounded bg-foreground/8" />
          )
        }
      />

      <CardItem
        title={t('account:profile.signOut')}
        description={
          signOutError ? (
            <span role="alert" className="text-destructive">
              {signOutError}
            </span>
          ) : (
            t('account:profile.signOutDesc')
          )
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            className="min-w-20"
            disabled={signingOut}
            onClick={() => void signOut()}
          >
            {signingOut && <Loader2 className="animate-spin" />}
            {t('account:profile.signOut')}
          </Button>
        }
      />
    </Card>
  )
}
