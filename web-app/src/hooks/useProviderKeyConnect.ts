import { useState } from 'react'
import { toast } from 'sonner'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { galleryLabel } from '@/lib/cloud-providers'
import { saveProviderApiKey } from '@/lib/provider-api-key'
import {
  checkProviderKey,
  recordKeyCheck,
  savedAnyway,
  type KeyCheckOutcome,
} from '@/lib/provider-key-check'

export type ProviderKeyConnectResult =
  | {
      kind: 'saved'
      providerName: string
      modelId: string | null
      /** Saved without the provider confirming the key, and why. */
      unverifiedReason?: string
    }
  /** Refused, failed to save, or a check was already running. */
  | { kind: 'notSaved' }

/**
 * Connecting a cloud provider by API key, shared by the Add provider dialog
 * and the first-run cloud step: ask the provider before calling it connected.
 * A key it calls invalid is not saved — `keyError` says why, and the same key
 * can then be saved anyway; a key it could not be asked about is saved and
 * remembered as unverified.
 */
export function useProviderKeyConnect({
  duringOnboarding,
}: {
  duringOnboarding: boolean
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  // Destructured, like the dialog this came from and the tests that mock it.
  const { updateProvider } = useModelProvider()
  const [checking, setChecking] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  // The key the provider called invalid, which the user may save anyway.
  const [refusedKey, setRefusedKey] = useState<string | null>(null)

  const clearKeyError = () => {
    setKeyError(null)
    setRefusedKey(null)
  }

  /** Whether "Save anyway" applies to the key as typed now. */
  const canSaveAnyway = (typedKey: string) =>
    Boolean(keyError) && refusedKey === typedKey.trim()

  /** Check `typedKey`, then save it; `saveAnyway` saves one it refused. */
  const connect = async (
    provider: ModelProvider,
    typedKey: string,
    saveAnyway = false
  ): Promise<ProviderKeyConnectResult> => {
    const key = typedKey.trim()
    if (!key || checking) return { kind: 'notSaved' }

    let outcome: KeyCheckOutcome
    if (saveAnyway && keyError && refusedKey === key) {
      outcome = savedAnyway(keyError)
    } else {
      clearKeyError()
      setChecking(true)
      try {
        outcome = await checkProviderKey(provider, key, serviceHub)
      } finally {
        setChecking(false)
      }
      if (outcome.kind === 'refused') {
        setKeyError(
          outcome.reason === 'ownServer'
            ? outcome.message
            : [
                t('setup:cloudStep.keyRejected', {
                  provider: galleryLabel(provider.provider),
                }),
                outcome.message,
              ]
                .filter(Boolean)
                .join(' ')
        )
        if (outcome.reason === 'key') setRefusedKey(key)
        return { kind: 'notSaved' }
      }
    }

    try {
      saveProviderApiKey({
        provider,
        apiKey: key,
        duringOnboarding,
        updateProvider,
        serviceHub,
      })
    } catch (error) {
      // Keep the form up — the user is left with no key saved and should
      // know it.
      console.error('[useProviderKeyConnect] failed to save key', error)
      toast.error(t('setup:cloudStep.saveFailed'))
      return { kind: 'notSaved' }
    }
    recordKeyCheck(provider.provider, key, outcome)
    clearKeyError()

    return {
      kind: 'saved',
      providerName: provider.provider,
      modelId: provider.models?.[0]?.id ?? null,
      unverifiedReason:
        outcome.kind === 'unverified' ? outcome.message : undefined,
    }
  }

  return { connect, checking, keyError, canSaveAnyway, clearKeyError }
}
