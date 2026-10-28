import { CORNER_ORDER, CornerSlot } from '@/containers/corner/cornerStack'
import { useOnboardingModelReminder } from '@/hooks/useOnboardingModelReminder'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useOnboardingStore } from '@/stores/onboarding-store'
import {
  activeUpdateBannerSlot,
  useUpdateBannerSlots,
} from '@/stores/update-banner-store'

import { DownloadStrip } from './DownloadStrip'
// First: the root layout loads this panel ahead of `index.css`, and
// `handoff.css` opens with the app's layer order.
import './handoff.css'
import './onboarding.css'

/**
 * The run's downloads after a handoff to the chat: the setup screen's strip,
 * floating bottom-right over the app, with a way to dismiss it.
 * `OnboardingRuntime` decides when it shows.
 *
 * With nothing left to download it only says the model is ready — or, with
 * no model ready either, shows only its links — and `yieldsCorner` gives the
 * corner to an update banner or the model reminder there: it comes back once
 * they are gone, until it is dismissed. Live progress never gives way.
 */
export function OnboardingHandoffPanel({
  yieldsCorner = false,
}: {
  yieldsCorner?: boolean
}) {
  const { t } = useTranslation()
  const updateBanner = useUpdateBannerSlots(
    (state) => activeUpdateBannerSlot(state.claimed) !== null
  )
  const { showOnboardingModelReminder } = useOnboardingModelReminder()

  if (yieldsCorner && (updateBanner || showOnboardingModelReminder)) {
    return null
  }

  return (
    <CornerSlot order={CORNER_ORDER.handoff}>
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
            data-testid="onboarding-handoff-dismiss"
            onClick={() => useOnboardingStore.getState().dismissPanel()}
          >
            {t('onboarding-handoff:panel.dismiss')}
          </button>
        </div>
      </section>
    </CornerSlot>
  )
}
