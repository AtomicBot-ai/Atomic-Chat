import { Link, useNavigate } from '@tanstack/react-router'
import { Box, Cpu, Network, Play, RotateCw, Square } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useServerSetup, useSetupDone } from '@/hooks/useServerSetup'
import { useServedModel } from '@/containers/server/useServedModel'
import {
  finishEndpointGuide,
  SetupGuideHint,
  useEndpointGuide,
  useServerModelPending,
} from '@/containers/onboarding/SetupGuideHint'
import { getProviderTitle } from '@/lib/utils'
import { useOnboardingStore } from '@/stores/onboarding-store'
import './ServerControlPanel.css'

/**
 * Start/Stop for the Local API Server, plus the engine and model it serves
 * and the way to its connection details, at the top of the Server sidebar.
 * Driven by the same control hook as the Server pages, so they always agree.
 * There is no Restart: saving a change on a Server page applies it, and Stop
 * also unloads the models the server served (`turnOffLocalApiServer`).
 */
export function ServerControlPanel() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const control = useLocalApiServerControl()
  const setupDone = useSetupDone()
  const connections = useServerSetup(
    (state) =>
      state.configuredAgents.length + (state.endpointConfigured ? 1 : 0)
  )

  const modelChosen = useLocalApiServer(
    (state) => state.defaultModelLocalApiServer !== null
  )

  // While running, show what the server actually loaded; otherwise what it
  // will load on the next start.
  const served = useServedModel(control.isRunning)

  const busy = control.isBusy
  const starting = control.status === 'pending'

  // A first run handed off to the server waits for the model it is
  // downloading, which becomes the server's once it lands: Start holds until
  // then, on either path and with or without the hints, and the model rows
  // name it already.
  const modelPending = useServerModelPending()
  const waitingForModel = modelPending && !control.isRunning
  const setupChoice = useOnboardingStore((state) => state.choice)
  const pendingChoice = modelPending && !served.name ? setupChoice : null
  const engine =
    served.engine ??
    (pendingChoice ? getProviderTitle(pendingChoice.provider) : undefined)

  // First-run setup's endpoint hints walk the user through Configuration and
  // Engine & model to this button.
  const endpointGuide = useEndpointGuide()

  // Until the server is set up once, Start opens the setup guide: it picks
  // the model and what to connect, then starts the server itself. During the
  // endpoint hints the pages were that setup, so Start starts it. A model
  // already chosen on Engine & model leaves the guide nothing to pick, so
  // Start starts that one: opening the guide there read as a dead button.
  const power = () => {
    if (!control.isRunning && endpointGuide) {
      finishEndpointGuide()
      void control.toggle()
      return
    }
    if (!control.isRunning && !setupDone && !modelChosen) {
      useServerSetup.getState().openGuide()
      void navigate({ to: route.api.index })
      return
    }
    void control.toggle()
  }

  const powerLabel = starting
    ? t('common:navigation.serverStarting')
    : control.isRunning
      ? t('common:navigation.serverStop')
      : t('common:navigation.serverStart')

  return (
    <section
      className="desktop-server-control"
      aria-label={t('common:navigation.server')}
    >
      {/* The launch starts the server, so the hints may find it running:
          then their goal is reached, and Stop stays Stop. */}
      <SetupGuideHint
        path="endpoint"
        hint={2}
        running={control.status === 'running'}
      />
      <div className="dsc-actions">
        <button
          type="button"
          className={`dsc-power ${control.isRunning || starting ? 'dsc-stop' : 'dsc-start'} ${busy ? 'dsc-restarting' : ''}`}
          disabled={busy || waitingForModel}
          title={
            waitingForModel
              ? t('onboarding-server:guide.stillDownloading')
              : undefined
          }
          aria-busy={busy}
          data-testid="server-panel-power"
          onClick={power}
        >
          {control.status === 'running' && (
            <svg className="dsc-running-border" aria-hidden="true">
              <rect pathLength={100} rx={18} />
            </svg>
          )}
          <span key={powerLabel} className="dsc-power-label">
            {busy ? (
              <RotateCw size={14} />
            ) : control.isRunning ? (
              <Square size={14} />
            ) : (
              <Play size={14} />
            )}
            {powerLabel}
          </span>
        </button>
      </div>
      <div className="dsc-details">
        {/* Engine and model read alike: the label over the value. The model's
            quant follows its readable name on the same line, and the id
            clients pass (owner and quant included) is the row's tooltip. */}
        <Link
          to={route.api.model}
          className="dsc-detail dsc-model"
          title={engine}
          data-testid="server-panel-engine"
        >
          <Cpu size={15} />
          <span className="dsc-model-text">
            <span className="dsc-model-label">
              {t('common:navigation.engine')}
            </span>
            <span className="dsc-model-value">
              <strong>{engine ?? t('common:navigation.notSelected')}</strong>
            </span>
          </span>
        </Link>
        <Link
          to={route.api.model}
          className="dsc-detail dsc-model"
          title={
            pendingChoice
              ? t('onboarding-server:guide.stillDownloading')
              : served.model
          }
          data-testid="server-panel-model"
        >
          <Box size={15} />
          <span className="dsc-model-text">
            <span className="dsc-model-label">
              {t('common:navigation.model')}
            </span>
            {pendingChoice ? (
              <span className="dsc-model-value">
                <strong>{pendingChoice.title}</strong>
                <small className="dsc-model-pending">
                  {t('common:downloading')}
                </small>
              </span>
            ) : (
              <span className="dsc-model-value">
                <strong>
                  {served.name ?? t('common:navigation.notSelected')}
                </strong>
                {served.quant && <small>{served.quant}</small>}
              </span>
            )}
          </span>
        </Link>
        <Link
          to={route.api.connections}
          className="dsc-detail"
          data-testid="server-panel-connections"
        >
          <Network size={15} />
          <span>{t('common:navigation.connections')}</span>
          {connections > 0 && (
            <strong className="dsc-count">
              {t('common:navigation.connectionsCount', { count: connections })}
            </strong>
          )}
        </Link>
      </div>
    </section>
  )
}
