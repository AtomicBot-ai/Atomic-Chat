import { ArrowRight } from 'lucide-react'

import { useTranslation } from '@/i18n/react-i18next-compat'

import type { StepProps } from './types'

export function WelcomeStep({ next }: StepProps) {
  const { t } = useTranslation()
  return (
    <>
      <div className="ob-mark">
        <img
          src="/images/transparent-logo.png"
          alt={t('onboarding:welcome.logo')}
          draggable={false}
        />
      </div>
      <h1 tabIndex={-1}>{t('onboarding:welcome.title')}</h1>
      <p className="ob-lead">
        {t('onboarding:welcome.lead')}
        <br />
        {t('onboarding:welcome.leadDetail')}
      </p>
      <button type="button" className="ob-primary" onClick={() => next()}>
        {t('onboarding:welcome.start')}
        <ArrowRight size={17} aria-hidden="true" />
      </button>
    </>
  )
}
