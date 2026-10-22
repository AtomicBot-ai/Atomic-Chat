import { useCallback } from 'react'

import { localStorageKey } from '@/constants/localStorage'
import SetupBackendStep from '@/containers/SetupBackendStep'
import { useTranslation } from '@/i18n/react-i18next-compat'

import type { StepProps } from './types'

/**
 * Windows and Linux install on a CPU build and have a GPU build to offer;
 * this step offers it before the model is picked. Downloading one relaunches
 * the app, after the flag below is set, so the run comes back on the model.
 */
export function BackendStep({ next }: StepProps) {
  const { t } = useTranslation()
  const done = useCallback(
    (status: 'downloaded' | 'skipped') => {
      try {
        localStorage.setItem(localStorageKey.llamacppOnboardingDone, status)
      } catch (error) {
        console.warn('[onboarding] could not persist the backend step', error)
      }
      next(status === 'downloaded' ? 'backend_downloaded' : 'backend_skipped')
    },
    [next]
  )
  return (
    <>
      <h1 tabIndex={-1}>{t('setup:backendStep.title')}</h1>
      <p className="ob-lead">{t('setup:backendStep.description')}</p>
      <SetupBackendStep embedded onDone={done} />
    </>
  )
}
