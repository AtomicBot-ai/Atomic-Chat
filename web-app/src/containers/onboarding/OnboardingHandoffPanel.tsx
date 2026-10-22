import { useNavigate } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useOnboardingStore } from '@/stores/onboarding-store'

import { DownloadStrip } from './DownloadStrip'
// First: the root layout loads this panel ahead of `index.css`, and
// `handoff.css` opens with the app's layer order.
import './handoff.css'
import './onboarding.css'

/**
 * The run's downloads after a handoff to the chat: the setup screen's strip,
 * floating bottom-right over the app, with the way back to setup and a way to
 * put it away. `OnboardingRuntime` decides when it shows; "Back to setup"
 * only navigates, the setup route re-opens the run itself.
 */
export function OnboardingHandoffPanel() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <section
      className="ob-handoff"
      aria-label={t('onboarding-handoff:panel.label')}
      data-testid="onboarding-handoff"
    >
      <DownloadStrip />
      <div className="ob-handoff-links">
        <button
          type="button"
          className="ob-text"
          onClick={() => void navigate({ to: route.onboarding })}
        >
          {t('onboarding-handoff:panel.backToSetup')}
        </button>
        <button
          type="button"
          className="ob-text"
          onClick={() => useOnboardingStore.getState().dismissPanel()}
        >
          {t('onboarding-handoff:panel.dismiss')}
        </button>
      </div>
    </section>
  )
}
