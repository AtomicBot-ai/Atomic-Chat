import { MessageCircle, Server } from 'lucide-react'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { captureOnboardingEvent } from '@/lib/onboarding-telemetry'
import { waitsForChatModel } from '@/lib/onboarding/jobs'
import { useOnboardingStore } from '@/stores/onboarding-store'

import { ChoiceCard } from './ChoiceCard'
import type { StepProps } from './types'

type Purpose = 'everyday' | 'power_tools'

/**
 * "How will you use Atomic Chat?": everyday use opens the workspace now, or
 * the wait screen while the chosen model is still downloading; powering other
 * tools goes on to the server step. Shown only on builds
 * with the local API server (`serverAvailability`); elsewhere the run hands
 * off to chat after the step before.
 */
export function PurposeStep({ goTo, handOff }: StepProps) {
  const { t } = useTranslation()

  const choose = (purpose: Purpose) => {
    captureOnboardingEvent('onboarding_purpose', { purpose })
    if (purpose === 'power_tools') {
      goTo('server', 'power_tools')
      return
    }
    const { choice, jobs } = useOnboardingStore.getState()
    const { providers } = useModelProvider.getState()
    if (waitsForChatModel(choice, jobs, providers)) goTo('wait', 'everyday')
    else handOff('chat', 'everyday')
  }

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding-server:purpose.title')}</h1>
      <p className="ob-lead">{t('onboarding-server:purpose.lead')}</p>
      <div className="ob-choice-grid">
        <ChoiceCard
          icon={<MessageCircle aria-hidden="true" />}
          title={t('onboarding-server:purpose.everyday')}
          body={t('onboarding-server:purpose.everydayBody')}
          action={t('onboarding-server:purpose.everydayAction')}
          onClick={() => choose('everyday')}
        />
        <ChoiceCard
          icon={<Server aria-hidden="true" />}
          title={t('onboarding-server:purpose.power')}
          body={t('onboarding-server:purpose.powerBody')}
          action={t('onboarding-server:purpose.powerAction')}
          onClick={() => choose('power_tools')}
        />
      </div>
    </>
  )
}
