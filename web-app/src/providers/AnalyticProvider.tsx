import posthog from 'posthog-js'
import { useEffect } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import { useAnalytic } from '@/hooks/useAnalytic'

const DAILY_ACTIVE_KEY = 'posthog_last_daily_active'

function captureDailyActive() {
  const today = new Date().toISOString().slice(0, 10)
  const last = localStorage.getItem(DAILY_ACTIVE_KEY)
  if (last !== today) {
    posthog.capture('daily_active_user')
    localStorage.setItem(DAILY_ACTIVE_KEY, today)
  }
}

export function AnalyticProvider() {
  const { productAnalytic } = useAnalytic()
  const serviceHub = useServiceHub()

  useEffect(() => {
    if (!POSTHOG_KEY || !POSTHOG_HOST) {
      console.warn(
        'PostHog not initialized: Missing POSTHOG_KEY or POSTHOG_HOST environment variables'
      )
      return
    }
    if (productAnalytic) {
      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        person_profiles: 'always',
        persistence: 'localStorage',
        opt_out_capturing_by_default: true,

        sanitize_properties: function (properties) {
          const denylist = [
            '$pathname',
            '$initial_pathname',
            '$current_url',
            '$initial_current_url',
            '$host',
            '$initial_host',
            '$initial_person_info',
          ]

          denylist.forEach((key) => {
            if (properties[key]) {
              properties[key] = null
            }
          })

          return properties
        },
      })
      serviceHub
        .analytic()
        .getAppDistinctId()
        .then((id) => {
          if (id) posthog.identify(id)
        })
        .finally(() => {
          posthog.opt_in_capturing()
          posthog.register({ app_version: VERSION })
          serviceHub.analytic().updateDistinctId(posthog.get_distinct_id())

          posthog.capture('app_opened')
          captureDailyActive()
        })
    } else {
      posthog.opt_out_capturing()
    }
  }, [productAnalytic, serviceHub])

  return null
}
