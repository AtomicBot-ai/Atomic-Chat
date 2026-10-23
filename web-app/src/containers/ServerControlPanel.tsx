import { Link, useNavigate } from '@tanstack/react-router'
import { Box, Cpu, Network, Play, RotateCw, Square } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useServerSetup, useSetupDone } from '@/hooks/useServerSetup'
import { useServedModel } from '@/containers/server/useServedModel'
import {
  finishGuide,
  SetupGuideHint,
  useChatModelPending,
  useEndpointGuide,
} from '@/containers/onboarding/SetupGuideHint'
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

  // While running, show what the server actually loaded; otherwise what it
  // will load on the next start.
  const { engine, model, name, quant } = useServedModel(control.isRunning)

  const busy = control.isBusy
  const starting = control.status === 'pending'

  // First-run setup's endpoint hints walk the user through Configuration and
  // Engine & model to this button. Start waits for the model the run is
  // downloading, which becomes the server's once it lands.
  const endpointGuide = useEndpointGuide()
  const modelPending = useChatModelPending()
  const waitingForModel = endpointGuide && modelPending && !control.isRunning

  // Until the server is set up once, Start opens the setup guide: it picks
  // the model and what to connect, then starts the server itself. During the
  // endpoint hints the pages were that setup, so Start starts it.
  const power = () => {
    if (!control.isRunning && endpointGuide) {
      const setup = useServerSetup.getState()
      setup.markEndpointConfigured()
      setup.finishSetup()
      finishGuide()
      void control.toggle()
      return
    }
    if (!control.isRunning && !setupDone) {
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
      <SetupGuideHint path="endpoint" hint={2} />
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
          title={model}
          data-testid="server-panel-model"
        >
          <Box size={15} />
          <span className="dsc-model-text">
            <span className="dsc-model-label">
              {t('common:navigation.model')}
            </span>
            <span className="dsc-model-value">
              <strong>{name ?? t('common:navigation.notSelected')}</strong>
              {quant && <small>{quant}</small>}
            </span>
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
