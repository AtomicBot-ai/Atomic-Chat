import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Box, Cpu, Network, Play, RotateCw, Square } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { restartLocalApiServer } from '@/hooks/useRemoteAccess'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useServerSetup, useSetupDone } from '@/hooks/useServerSetup'
import { useServedModel } from '@/containers/server/useServedModel'
import './ServerControlPanel.css'

/**
 * Start/Stop and Restart for the Local API Server, plus the engine and model
 * it serves and the way to its connection details, at the top of the Server
 * sidebar. Driven by the same control hook as the Server pages, so they
 * always agree.
 */
export function ServerControlPanel() {
  const { t } = useTranslation()
  const hub = useServiceHub()
  const navigate = useNavigate()
  const control = useLocalApiServerControl()
  const setupDone = useSetupDone()
  const connections = useServerSetup(
    (state) =>
      state.configuredAgents.length + (state.endpointConfigured ? 1 : 0)
  )
  const [restarting, setRestarting] = useState(false)

  // While running, show what the server actually loaded; otherwise what it
  // will load on the next start.
  const { engine, model } = useServedModel(control.isRunning)

  const busy = restarting || control.isBusy
  const starting = control.status === 'pending' && !restarting

  // The shared restart: it loads the chosen model and brings a tunnel that
  // was online back with the server.
  const restart = async () => {
    setRestarting(true)
    try {
      await restartLocalApiServer(hub, control, { ensureModel: true })
    } finally {
      setRestarting(false)
    }
  }

  // Until the server is set up once, Start opens the setup guide: it picks
  // the model and what to connect, then starts the server itself.
  const power = () => {
    if (!control.isRunning && !setupDone) {
      useServerSetup.getState().openGuide()
      void navigate({ to: route.api.index })
      return
    }
    void control.toggle()
  }

  const powerLabel = restarting
    ? t('common:navigation.serverRestarting')
    : starting
      ? t('common:navigation.serverStarting')
      : control.isRunning
        ? t('common:navigation.serverStop')
        : t('common:navigation.serverStart')

  return (
    <section
      className="desktop-server-control"
      aria-label={t('common:navigation.server')}
    >
      <div className="dsc-actions">
        <button
          type="button"
          className={`dsc-power ${control.isRunning || starting ? 'dsc-stop' : 'dsc-start'} ${busy ? 'dsc-restarting' : ''}`}
          disabled={busy}
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
        <button
          type="button"
          className={`dsc-restart ${restarting ? 'dsc-restarting' : ''}`}
          aria-label={t('common:navigation.serverRestart')}
          title={t('common:navigation.serverRestart')}
          disabled={!control.isRunning || busy}
          onClick={() => void restart()}
        >
          <RotateCw size={16} />
        </button>
      </div>
      <div className="dsc-details">
        <Link to={route.api.model} className="dsc-detail">
          <Cpu size={15} />
          <span>{t('common:navigation.engine')}</span>
          <strong title={engine}>
            {engine ?? t('common:navigation.notSelected')}
          </strong>
        </Link>
        <Link to={route.api.model} className="dsc-detail">
          <Box size={15} />
          <span>{t('common:navigation.model')}</span>
          <strong title={model}>
            {model ?? t('common:navigation.notSelected')}
          </strong>
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
