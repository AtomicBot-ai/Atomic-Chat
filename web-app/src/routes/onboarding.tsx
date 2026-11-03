import { useState } from 'react'
import { createFileRoute, Navigate } from '@tanstack/react-router'

import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { route } from '@/constants/routes'
import { Onboarding } from '@/containers/onboarding/Onboarding'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useSetupCompleted } from '@/hooks/useSetupCompleted'
import { useThreads } from '@/hooks/useThreads'
import { shouldEnterOnboarding } from '@/lib/onboarding'
import { useOnboardingStore } from '@/stores/onboarding-store'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.onboarding as any)({
  component: OnboardingRoute,
})

/**
 * The first-run flow, drawn over the whole window (see `AppLayout`). Open to a
 * run in progress, to "Back to setup" after a handoff, and to an install the
 * home route would send here anyway; anyone else lands on the home page.
 */
function OnboardingRoute() {
  const setupCompleted = useSetupCompleted()
  const providers = useModelProvider((state) => state.providers)
  const threads = useThreads((state) => state.threads)
  // Decided once on arrival: the handoff itself changes every input below.
  const [allowed] = useState(() => {
    const { phase } = useOnboardingStore.getState()
    return (
      phase === 'active' ||
      phase === 'handedOff' ||
      shouldEnterOnboarding({
        providers,
        hasPriorThread: Object.values(threads).some(
          (thread) => thread.id !== TEMPORARY_CHAT_ID
        ),
        setupCompleted,
        force: typeof FORCE_ONBOARDING !== 'undefined' && FORCE_ONBOARDING,
      })
    )
  })
  if (!allowed) return <Navigate to={route.home} replace />
  return <Onboarding />
}
