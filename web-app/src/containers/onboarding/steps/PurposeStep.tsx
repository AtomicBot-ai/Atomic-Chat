import { MessageCircle, Server } from 'lucide-react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { captureOnboardingEvent } from '@/lib/onboarding-telemetry'

import { ChoiceCard } from './ChoiceCard'
import type { StepProps } from './types'

type Purpose = 'everyday' | 'power_tools'

/**
 * "How will you use Atomic Chat?": everyday use opens the workspace now;
 * powering other tools goes on to the server step. Shown only on builds
 * with the local API server (`serverAvailability`); elsewhere the run hands
 * off to chat after the step before.
 */
export function PurposeStep({ goTo, handOff }: StepProps) {
  const { t } = useTranslation()

  const choose = (purpose: Purpose) => {
    captureOnboardingEvent('onboarding_purpose', { purpose })
    if (purpose === 'everyday') handOff('chat', 'everyday')
    else goTo('server', 'power_tools')
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
