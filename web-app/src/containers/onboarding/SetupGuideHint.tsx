import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'

import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { captureOnboardingEvent } from '@/lib/onboarding-telemetry'
import {
  useOnboardingStore,
  type OnboardingGuide,
} from '@/stores/onboarding-store'

import './guide.css'

type GuidePath = OnboardingGuide['path']

/** Each path's hints in order, named by their copy in `onboarding-server:guide`. */
const HINTS = {
  endpoint: ['settings', 'model', 'start'],
  agents: ['pick', 'connect'],
} as const satisfies Record<GuidePath, readonly string[]>

/** The page each endpoint hint is on; "Next hint" goes to the next one. */
const ENDPOINT_PAGES = [
  route.settings.local_api_server,
  route.api.model,
  route.api.index,
] as const

/** `onboarding_guide`: how a hint was left, and on which. */
function captureGuide(
  action: 'next' | 'skip' | 'done',
  guide: OnboardingGuide
) {
  captureOnboardingEvent('onboarding_guide', {
    guide_path: guide.path,
    hint: guide.hint,
    guide_action: action,
  })
}

/** Whether the run's guide is on this hint now. */
export function useGuideHint(path: GuidePath, hint: number): boolean {
  return useOnboardingStore(
    (state) => state.guide?.path === path && state.guide.hint === hint
  )
}

/** The endpoint hints are up, whichever page they are on. */
export function useEndpointGuide(): boolean {
  return useOnboardingStore((state) => state.guide?.path === 'endpoint')
}

/** The run's chat model has not landed yet: queued, downloading, paused or interrupted. */
export function useChatModelPending(): boolean {
  return useOnboardingStore((state) =>
    state.jobs.some((job) => job.kind === 'chat' && job.phase !== 'done')
  )
}

/**
 * The run handed off to the server while its chat model is still on its way.
 * Once it lands, `OnboardingRuntime` makes it the server's model, so setting
 * the server up before then would serve another one.
 */
export function useServerModelPending(): boolean {
  return useOnboardingStore(
    (state) =>
      state.phase === 'handedOff' &&
      (state.destination === 'endpoint' || state.destination === 'agents') &&
      state.jobs.some((job) => job.kind === 'chat' && job.phase !== 'done')
  )
}

/** The hints did their job: the server started, or the tool is connected. */
export function finishGuide(): void {
  const { guide, setGuide } = useOnboardingStore.getState()
  if (!guide) return
  captureGuide('done', guide)
  setGuide(null)
}

/**
 * An agent card's Configure (or, for a tool already set up, its connection
 * details) while "Pick your tool" is up: the hints follow it into the setup
 * guide, or end, since there is nothing left to connect.
 */
export function pickAgentHint(configured: boolean): void {
  const { guide, setGuide } = useOnboardingStore.getState()
  if (guide?.path !== 'agents' || guide.hint !== 0) return
  captureGuide(configured ? 'done' : 'next', guide)
  setGuide(configured ? null : { path: 'agents', hint: 1 })
}

type HintProps = { path: GuidePath; hint: number }

/**
 * One of the hints a server handoff leaves on the real Server pages, shown
 * where the run's guide (`useOnboardingStore.guide`) points: the endpoint
 * path walks Configuration → Engine & model → Start, the agents path the
 * agent cards → the setup guide. Mounted on each of those pages; only the
 * current one renders.
 */
export function SetupGuideHint({ path, hint }: HintProps) {
  const visible = useGuideHint(path, hint)
  return visible ? <Hint path={path} hint={hint} /> : null
}

function Hint({ path, hint }: HintProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const modelPending = useChatModelPending()
  const ref = useRef<HTMLElement>(null)
  const copy = HINTS[path][hint]

  // A hint further down the page, or in a sidebar scrolled away, comes into
  // view when it is the current one.
  useEffect(() => {
    const reduceMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)'
    ).matches
    ref.current?.scrollIntoView?.({
      block: 'nearest',
      behavior: reduceMotion ? 'auto' : 'smooth',
    })
  }, [])

  const skip = () => {
    const store = useOnboardingStore.getState()
    captureGuide('skip', { path, hint })
    store.setGuide(null)
    store.dismissPanel()
  }

  const next = () => {
    captureGuide('next', { path, hint })
    useOnboardingStore.getState().setGuide({ path, hint: hint + 1 })
    void navigate({ to: ENDPOINT_PAGES[hint + 1] })
  }

  // Picking a tool does not depend on the model; every later hint is about
  // settings that do.
  const showDownloading = modelPending && !(path === 'agents' && hint === 0)
  const hasNext = path === 'endpoint' && hint < HINTS.endpoint.length - 1

  return (
    <section
      ref={ref}
      className="ob-context-guide"
      aria-label={t('onboarding-server:guide.label')}
    >
      <div>
        <h3>{t(`onboarding-server:guide.${copy}.title`)}</h3>
        <p>{t(`onboarding-server:guide.${copy}.body`)}</p>
        {showDownloading && (
          <small>{t('onboarding-server:guide.downloading')}</small>
        )}
      </div>
      <div className="ob-context-actions">
        <button type="button" onClick={skip}>
          {t('onboarding-server:guide.skip')}
        </button>
        {hasNext && (
          <button type="button" onClick={next}>
            {t('onboarding-server:guide.next')}
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  )
}
