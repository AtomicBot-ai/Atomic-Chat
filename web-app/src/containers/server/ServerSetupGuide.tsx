import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  Network,
  RotateCw,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { route } from '@/constants/routes'
import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
import { AgentIcon } from '@/containers/AgentIcon'
import {
  finishGuide,
  SetupGuideHint,
  useServerModelPending,
} from '@/containers/onboarding/SetupGuideHint'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import {
  restartLocalApiServer,
  startLocalApiServerAndSettle,
} from '@/hooks/useRemoteAccess'
import {
  useServerSetup,
  useSetupDone,
  type SetupGuideEntry,
} from '@/hooks/useServerSetup'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  agentConnectHost,
  isGuidedAgent,
  writeAgentConfig,
} from '@/lib/integration-agent-setup'
import { useLaunchStore } from '@/stores/launch-store'

import {
  EngineModelFields,
  initialChoice,
  useServableEngines,
  type ServedModel,
} from './ServerModelPicker'
import { ServerButton, ServerCopyButton, ServerField } from './ServerPageParts'

/** The agents the guide leads with, as large tiles; the rest fold away. */
export const FEATURED_AGENT_IDS = ['claude-code', 'codex', 'atomic-agent']

export const GUIDED_AGENTS = [
  ...FEATURED_AGENT_IDS.flatMap((id) =>
    INTEGRATION_AGENTS.filter((agent) => agent.id === id)
  ),
  ...INTEGRATION_AGENTS.filter(
    (agent) => !FEATURED_AGENT_IDS.includes(agent.id)
  ),
].filter(isGuidedAgent)

type Step =
  | 'choose'
  | 'agent'
  | 'endpoint'
  | 'review'
  | 'preparing'
  | 'error'
  | 'done'
type Path = 'agent' | 'endpoint'

/** What "Configure & start" does, in order; each is real work. */
const TASKS = ['engine', 'model', 'server', 'connect'] as const

const isValidPort = (port: string) =>
  /^\d+$/.test(port.trim()) && Number(port) >= 1 && Number(port) <= 65535

function firstStep(entry: SetupGuideEntry): { step: Step; path: Path } {
  if (entry.path === 'endpoint') return { step: 'endpoint', path: 'endpoint' }
  if (entry.path === 'agent')
    return { step: entry.agentId ? 'review' : 'agent', path: 'agent' }
  return { step: 'choose', path: 'agent' }
}

/**
 * Server → Overview's setup guide, the prototype's Agent / Endpoint wizard on
 * the real server: it saves the chosen model as the server's, starts (or
 * restarts) the server with it, and writes the agent's own config — the same
 * write as All integrations. Progress is the work that has finished, not a
 * timer; a failed step says why and retries from there.
 */
export function ServerSetupGuide({ entry }: { entry: SetupGuideEntry }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const hub = useServiceHub()
  const control = useLocalApiServerControl()
  const engines = useServableEngines()
  const saved = useLocalApiServer((state) => state.defaultModelLocalApiServer)
  const lastRun = useLocalApiServer((state) => state.lastServerModels[0])
  const serverHost = useLocalApiServer((state) => state.serverHost)
  const serverPort = useLocalApiServer((state) => state.serverPort)
  const apiPrefix = useLocalApiServer((state) => state.apiPrefix)
  const apiKey = useLocalApiServer((state) => state.apiKey)
  const installed = useLaunchStore((state) => state.installed)
  const setupDone = useSetupDone()
  const closeGuide = useServerSetup((state) => state.closeGuide)
  // First-run setup's model becomes the server's once it lands; configuring
  // before then would serve another one.
  const waitingForModel = useServerModelPending()

  const start = firstStep(entry)
  const [step, setStep] = useState<Step>(start.step)
  const [path, setPath] = useState<Path>(start.path)
  const [agentId, setAgentId] = useState(
    (entry.path === 'agent' && entry.agentId) || FEATURED_AGENT_IDS[0]
  )
  const [picked, setPicked] = useState<ServedModel | null>(null)
  const [port, setPort] = useState(String(serverPort))
  const [moreAgents, setMoreAgents] = useState(false)
  const [finished, setFinished] = useState(0)
  const [failure, setFailure] = useState<{
    task: number
    message: string
  } | null>(null)
  const portChanged = useRef(false)
  const top = useRef<HTMLElement>(null)

  // Shown once, it stays through to its success screen; opened from a card
  // further down the page, it comes into view.
  useEffect(() => {
    useServerSetup.getState().holdGuide()
    top.current?.scrollIntoView?.({ block: 'start' })
  }, [])

  const agent =
    INTEGRATION_AGENTS.find((candidate) => candidate.id === agentId) ??
    GUIDED_AGENTS[0]
  const choice = picked ?? initialChoice(engines, saved, lastRun)
  const engineTitle = engines.find(
    (e) => e.provider === choice?.provider
  )?.title
  const endpointPort = path === 'endpoint' ? port : String(serverPort)
  const endpoint = `http://${agentConnectHost(serverHost)}:${endpointPort}${apiPrefix}`
  const target = path === 'agent' ? agent.name : t('api:guide.endpointTarget')
  const notInstalled =
    path === 'agent' && agent.installable && installed[agent.id] === false

  const runTask = async (task: (typeof TASKS)[number], model: ServedModel) => {
    const server = useLocalApiServer.getState()
    switch (task) {
      case 'engine':
        if (!engines.some((e) => e.provider === model.provider))
          throw new Error(t('api:guide.engineMissing'))
        return
      case 'model':
        server.setDefaultModelLocalApiServer(model)
        if (path === 'endpoint' && portChanged.current)
          server.setServerPort(Number(port))
        return
      case 'server': {
        const running = useAppState.getState().serverStatus === 'running'
        const served = server.lastServerModels[0]
        const sameModel =
          served?.provider === model.provider && served?.model === model.model
        const ok = !running
          ? await startLocalApiServerAndSettle(control.start, {
              ensureModel: true,
            })
          : portChanged.current || !sameModel
            ? await restartLocalApiServer(hub, control, { ensureModel: true })
            : true
        if (!ok) throw new Error(t('api:guide.serverFailed'))
        return
      }
      case 'connect':
        if (path === 'agent') {
          await writeAgentConfig(
            agent,
            model.model,
            useLocalApiServer.getState()
          )
          useServerSetup.getState().markAgentConfigured(agent.id)
        } else {
          useServerSetup.getState().markEndpointConfigured()
        }
        return
    }
  }

  const run = async (from: number) => {
    if (!choice) return
    setStep('preparing')
    setFailure(null)
    for (let index = from; index < TASKS.length; index++) {
      setFinished(index)
      try {
        await runTask(TASKS[index], choice)
      } catch (error) {
        setFailure({
          task: index,
          message: error instanceof Error ? error.message : String(error),
        })
        setStep('error')
        return
      }
    }
    setFinished(TASKS.length)
    useServerSetup.getState().finishSetup()
    finishGuide()
    setStep('done')
  }

  const configure = () => {
    portChanged.current =
      path === 'endpoint' &&
      Number(port) !== useLocalApiServer.getState().serverPort
    void run(0)
  }

  const chooseAgent = (next: IntegrationAgent) => {
    setAgentId(next.id)
    setPath('agent')
    setStep('review')
  }

  const progress = Math.round((finished / TASKS.length) * 100)
  const taskLabels = [
    t('api:guide.taskEngine'),
    t('api:guide.taskModel'),
    t('api:guide.taskServer'),
    path === 'agent'
      ? t('api:guide.taskConnect', { name: agent.name })
      : t('api:guide.taskEndpoint'),
  ]

  return (
    <section ref={top} className="sp-guide" aria-label={t('api:guide.label')}>
      {/* First-run setup's "Connect your tool", until the work starts. */}
      {(step === 'agent' || step === 'review') && (
        <SetupGuideHint path="agents" hint={1} />
      )}
      <div className="sp-guide-top">
        <span>
          <CircleHelp size={16} />
          {setupDone ? t('api:guide.another') : t('api:guide.tagline')}
        </span>
        <ServerButton aria-label={t('api:guide.close')} onClick={closeGuide}>
          <X size={16} />
        </ServerButton>
      </div>

      {step === 'choose' && (
        <>
          <h2>{t('api:guide.chooseTitle')}</h2>
          <p>{t('api:guide.chooseBody')}</p>
          <div className="sp-choice-grid">
            <button
              type="button"
              className="sp-choice"
              onClick={() => {
                setPath('agent')
                setStep('agent')
              }}
            >
              <Bot />
              <strong>{t('api:guide.agentChoice')}</strong>
              <span>{t('api:guide.agentChoiceBody')}</span>
              <ArrowRight className="sp-choice-arrow" size={18} />
            </button>
            <button
              type="button"
              className="sp-choice"
              onClick={() => {
                setPath('endpoint')
                setStep('endpoint')
              }}
            >
              <Network />
              <strong>{t('api:guide.endpointChoice')}</strong>
              <span>{t('api:guide.endpointChoiceBody')}</span>
              <ArrowRight className="sp-choice-arrow" size={18} />
            </button>
          </div>
          <button type="button" className="sp-link" onClick={closeGuide}>
            {t('api:guide.myself')}
          </button>
        </>
      )}

      {step === 'agent' && (
        <>
          <div className="sp-step">{t('api:guide.stepTool')}</div>
          <h2>{t('api:guide.agentTitle')}</h2>
          <p>{t('api:guide.agentBody')}</p>
          <div className="sp-agent-choices">
            {GUIDED_AGENTS.filter((a) => FEATURED_AGENT_IDS.includes(a.id)).map(
              (a) => (
                <button
                  type="button"
                  className="sp-agent-choice"
                  key={a.id}
                  onClick={() => chooseAgent(a)}
                >
                  <span className="sp-agent-icon" aria-hidden="true">
                    <AgentIcon agent={a} />
                  </span>
                  <strong>{a.name}</strong>
                  <span>{a.description}</span>
                  <ArrowRight size={16} />
                </button>
              )
            )}
          </div>
          <button
            type="button"
            className="sp-link"
            aria-expanded={moreAgents}
            onClick={() => setMoreAgents((open) => !open)}
          >
            {t('api:guide.moreAgents')} <ChevronDown size={14} />
          </button>
          {moreAgents && (
            <div className="sp-more-agents">
              {GUIDED_AGENTS.filter(
                (a) => !FEATURED_AGENT_IDS.includes(a.id)
              ).map((a) => (
                <button type="button" key={a.id} onClick={() => chooseAgent(a)}>
                  <span className="sp-agent-icon" aria-hidden="true">
                    <AgentIcon agent={a} />
                  </span>
                  {a.name}
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {step === 'endpoint' && (
        <>
          <div className="sp-step">{t('api:guide.stepEndpoint')}</div>
          <h2>{t('api:guide.endpointTitle')}</h2>
          <p>{t('api:guide.endpointBody')}</p>
          <div className="sp-fields">
            <ServerField label={t('api:connections.access')}>
              <input
                value={
                  serverHost === '0.0.0.0'
                    ? t('settings:serverConfig.hostNetwork')
                    : t('settings:serverConfig.hostLocal')
                }
                readOnly
              />
            </ServerField>
            <ServerField label={t('api:guide.port')}>
              <input
                value={port}
                inputMode="numeric"
                aria-invalid={!isValidPort(port)}
                onChange={(event) => setPort(event.target.value)}
              />
            </ServerField>
          </div>
          {!isValidPort(port) && (
            <p role="alert" className="sp-error">
              {t('api:guide.portInvalid')}
            </p>
          )}
          <div className="sp-code">{endpoint}</div>
        </>
      )}

      {step === 'review' && (
        <>
          <div className="sp-step">{t('api:guide.stepReview')}</div>
          <h2>
            {path === 'agent'
              ? t('api:guide.reviewAgentTitle', { name: agent.name })
              : t('api:guide.reviewEndpointTitle')}
          </h2>
          <p>{t('api:guide.reviewBody')}</p>
          {choice ? (
            <div className="sp-review-grid">
              <div>
                <EngineModelFields
                  engines={engines}
                  choice={choice}
                  onChange={setPicked}
                />
              </div>
              <div className="sp-review-summary">
                <strong>{t('api:guide.nextTitle')}</strong>
                <ol>
                  <li>
                    {t('api:guide.nextPrepare', {
                      engine: engineTitle,
                      model: choice.model,
                    })}
                  </li>
                  <li>{t('api:guide.nextStart')}</li>
                  <li>
                    {path === 'agent'
                      ? t('api:guide.nextConnect', { name: agent.name })
                      : t('api:guide.nextEndpoint')}
                  </li>
                </ol>
                <code>{endpoint}</code>
                <small>
                  {serverHost === '0.0.0.0'
                    ? t('api:connections.accessNetwork')
                    : t('api:connections.accessDevice')}
                  {' · '}
                  {apiKey.trim()
                    ? t('api:connections.keyRequired')
                    : t('api:connections.noKey')}
                </small>
              </div>
            </div>
          ) : (
            <div className="sp-note">
              <span className="min-w-0">{t('api:model.emptyBody')}</span>
              <Link to={route.hub.index} className="sp-button">
                {t('api:model.openHub')}
              </Link>
            </div>
          )}
          {notInstalled && (
            <div className="sp-note">
              <span className="min-w-0">
                {t('api:guide.notInstalled', { name: agent.name })}
              </span>
              <Link
                to={route.launch.index}
                hash={agent.id}
                className="sp-button"
              >
                {t('api:agents.allIntegrations')}
              </Link>
            </div>
          )}
        </>
      )}

      {(step === 'preparing' || step === 'error') && (
        <>
          <div className="sp-step">{t('api:guide.stepPreparing')}</div>
          <h2>
            {step === 'error'
              ? t('api:guide.errorTitle')
              : t('api:guide.preparingTitle')}
          </h2>
          <p>
            {step === 'error' && failure
              ? failure.message
              : t('api:guide.preparingBody')}
          </p>
          <div
            className="sp-progress"
            role="progressbar"
            aria-label={t('api:guide.progress')}
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${progress}%` }} />
          </div>
          <div className="sp-row">
            <span>{choice?.model}</span>
            <span>{progress}%</span>
          </div>
          <ul className="sp-checklist">
            {taskLabels.map((label, index) => (
              <li
                key={label}
                className={
                  index < finished
                    ? 'complete'
                    : failure?.task === index
                      ? 'failed'
                      : undefined
                }
              >
                {failure?.task === index ? (
                  <X size={15} />
                ) : (
                  <Check size={15} />
                )}
                {label}
              </li>
            ))}
          </ul>
          {step === 'error' && failure && (
            <div className="sp-actions">
              <ServerButton primary onClick={() => void run(failure.task)}>
                <RotateCw size={14} />
                {t('api:guide.retry')}
              </ServerButton>
              <ServerButton onClick={() => setStep('review')}>
                {t('api:guide.reviewSettings')}
              </ServerButton>
            </div>
          )}
        </>
      )}

      {step === 'done' && (
        <>
          <div className="sp-success-icon">
            <Check size={25} />
          </div>
          <h2>
            {path === 'agent'
              ? t('api:guide.doneAgentTitle', { name: agent.name })
              : t('api:guide.doneEndpointTitle')}
          </h2>
          <p>{t('api:guide.doneBody', { model: choice?.model, target })}</p>
          <div className="sp-copy-row">
            <code>{endpoint}</code>
            <ServerCopyButton
              value={endpoint}
              label={t('api:connections.copyUrl')}
            />
          </div>
          <div className="sp-actions">
            <ServerButton
              primary
              onClick={() => {
                closeGuide()
                void navigate({ to: route.api.connections })
              }}
            >
              {t('api:guide.viewConnection')} <ArrowRight size={15} />
            </ServerButton>
            <ServerButton onClick={closeGuide}>
              {t('api:guide.done')}
            </ServerButton>
          </div>
        </>
      )}

      {(step === 'agent' || step === 'endpoint' || step === 'review') && (
        <div className="sp-guide-footer">
          <ServerButton
            onClick={() => setStep(step === 'review' ? path : 'choose')}
          >
            <ArrowLeft size={14} />
            {t('api:guide.back')}
          </ServerButton>
          {step === 'endpoint' && (
            <ServerButton
              primary
              disabled={!isValidPort(port)}
              onClick={() => setStep('review')}
            >
              {t('api:guide.continue')} <ArrowRight size={14} />
            </ServerButton>
          )}
          {step === 'review' && (
            <ServerButton
              primary
              disabled={!choice || control.isBusy || waitingForModel}
              onClick={configure}
            >
              {waitingForModel
                ? t('onboarding-server:guide.waitingForModel')
                : t('api:guide.configure')}{' '}
              <ArrowRight size={14} />
            </ServerButton>
          )}
        </div>
      )}

      <details className="sp-guide-help">
        <summary>{t('api:guide.helpTitle')}</summary>
        <div className="sp-help-grid">
          <Link to={route.settings.local_api_server}>
            <strong>{t('common:navigation.configuration')}</strong>
            <span>{t('api:guide.helpConfiguration')}</span>
          </Link>
          <Link to={route.api.model}>
            <strong>{t('api:model.panelTitle')}</strong>
            <span>{t('api:guide.helpModel')}</span>
          </Link>
          <Link to={route.settings.remote_lan}>
            <strong>{t('common:navigation.remoteAccess')}</strong>
            <span>{t('api:guide.helpRemote')}</span>
          </Link>
        </div>
      </details>
    </section>
  )
}
