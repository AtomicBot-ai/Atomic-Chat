/**
 * The install's analytics identity.
 *
 * posthog-js keeps its anonymous id in webview localStorage, which a factory
 * reset clears and which can be lost in other ways too. On its own, every such
 * wipe would make the install a new PostHog person, and so a new member of
 * any experiment keyed by person. The app therefore stores the id in
 * `settings.json` on the first launch and puts posthog back on it on every
 * later one; the same id is the Sentry user.
 */

import posthog from 'posthog-js'

import type { AnalyticService } from '@/services/analytic/types'

/**
 * Call after `posthog.init` and before `opt_in_capturing`, so nothing is sent
 * under an id posthog has just made up for a wiped storage.
 */
export async function restoreInstallDistinctId(
  analytic: AnalyticService
): Promise<void> {
  const stored = await analytic.getAppDistinctId()
  if (stored) {
    if (stored !== posthog.get_distinct_id()) posthog.identify(stored)
    return
  }
  await analytic.updateDistinctId(posthog.get_distinct_id())
}
