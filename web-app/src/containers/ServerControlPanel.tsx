import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Box, Cpu, Play, RotateCw, Square } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { getProviderTitle } from '@/lib/utils'
import './ServerControlPanel.css'

/**
 * Start/Stop and Restart for the Local API Server, plus the engine and model
 * it serves, at the top of the Server sidebar. Driven by the same control
 * hook as the API page, so the two always agree.
 */
export function ServerControlPanel() {
  const { t } = useTranslation()
  const control = useLocalApiServerControl()
  const defaultModel = useLocalApiServer(
    (state) => state.defaultModelLocalApiServer
  )
  const lastServerModels = useLocalApiServer((state) => state.lastServerModels)
  const [restarting, setRestarting] = useState(false)

  // While running, show what the server actually loaded; otherwise what it
  // will load on the next start.
  const served =
    (control.isRunning ? lastServerModels[0] : undefined) ?? defaultModel
  const engine = served ? getProviderTitle(served.provider) : undefined
  const model = served?.model

  const busy = restarting || control.isBusy
  const starting = control.status === 'pending' && !restarting

  const restart = async () => {
    setRestarting(true)
    try {
      await control.stop()
      await control.start()
    } finally {
      setRestarting(false)
    }
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
          onClick={() => void control.toggle()}
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
        <Link to={route.api.index} className="dsc-detail">
          <Cpu size={15} />
          <span>{t('common:navigation.engine')}</span>
          <strong title={engine}>
            {engine ?? t('common:navigation.notSelected')}
          </strong>
        </Link>
        <Link to={route.api.index} className="dsc-detail">
          <Box size={15} />
          <span>{t('common:navigation.model')}</span>
          <strong title={model}>
            {model ?? t('common:navigation.notSelected')}
          </strong>
        </Link>
      </div>
    </section>
  )
}
