import { ArrowRight, Server, Terminal } from 'lucide-react'

import { isServableEngine } from '@/containers/server/ServerModelPicker'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useOnboardingStore } from '@/stores/onboarding-store'

import { ChoiceCard } from './ChoiceCard'
import type { StepProps } from './types'

/**
 * "Connect on your terms.": an endpoint of one's own, or an agent connected
 * to the local API server. Either hands off to the real Server pages with
 * hints on them (`SetupGuideHint`); neither starts the server — Start does,
 * once the model is ready.
 *
 * The server runs local engines only. A chosen model it cannot serve — none,
 * a cloud one, an engine it does not run here — gets the way back to the
 * model step instead. The engine is what is checked, not the model, so a
 * model still downloading for it counts.
 */
export function ServerStep({ goTo, handOff }: StepProps) {
  const { t } = useTranslation()
  const choice = useOnboardingStore((state) => state.choice)
  const providers = useModelProvider((state) => state.providers)
  const servable =
    choice !== null &&
    providers.some(
      (provider) =>
        provider.provider === choice.provider && isServableEngine(provider)
    )

  const connect = (destination: 'endpoint' | 'agents') => {
    // The hints are the setup guide on this path; the first-visit one would
    // cover Overview — the agent cards, and the page the Start hint is on.
    useServerSetup.getState().closeGuide()
    handOff(
      destination,
      destination === 'endpoint' ? 'configure_endpoint' : 'connect_agent'
    )
  }

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding-server:server.title')}</h1>
      <p className="ob-lead">{t('onboarding-server:server.lead')}</p>
      {servable ? (
        <div className="ob-choice-grid">
          <ChoiceCard
            icon={<Server aria-hidden="true" />}
            title={t('onboarding-server:server.endpoint')}
            body={t('onboarding-server:server.endpointBody')}
            action={t('onboarding-server:server.endpointAction')}
            onClick={() => connect('endpoint')}
          />
          <ChoiceCard
            icon={<Terminal aria-hidden="true" />}
            title={t('onboarding-server:server.agents')}
            body={t('onboarding-server:server.agentsBody')}
            action={t('onboarding-server:server.agentsAction')}
            onClick={() => connect('agents')}
          />
        </div>
      ) : (
        <div className="ob-confirm">
          <h2>{t('onboarding-server:server.incompatibleTitle')}</h2>
          <p>
            {choice
              ? t('onboarding-server:server.incompatibleModel', {
                  name: choice.title,
                })
              : t('onboarding-server:server.incompatibleNone')}
          </p>
          <button
            type="button"
            className="ob-primary"
            onClick={() => goTo('model', 'choose_local_model')}
          >
            {t('onboarding-server:server.chooseModel')}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}
