import type { ServiceHub } from '@/services'
import {
  initializeServiceHubStore,
  useServiceStore,
} from '@/hooks/useServiceHub'

type ServiceInstances = {
  [Name in keyof ServiceHub]: ReturnType<ServiceHub[Name]>
}

export type ServiceHubOverrides = Partial<ServiceInstances>

export function createMockServiceHub(
  overrides: ServiceHubOverrides = {}
): ServiceHub {
  const emptyService = Object.freeze({})
  const services: ServiceInstances = {
    theme: overrides.theme ?? (emptyService as ServiceInstances['theme']),
    window: overrides.window ?? (emptyService as ServiceInstances['window']),
    events: overrides.events ?? (emptyService as ServiceInstances['events']),
    hardware:
      overrides.hardware ?? (emptyService as ServiceInstances['hardware']),
    app: overrides.app ?? (emptyService as ServiceInstances['app']),
    analytic:
      overrides.analytic ?? (emptyService as ServiceInstances['analytic']),
    messages:
      overrides.messages ?? (emptyService as ServiceInstances['messages']),
    mcp: overrides.mcp ?? (emptyService as ServiceInstances['mcp']),
    threads: overrides.threads ?? (emptyService as ServiceInstances['threads']),
    providers:
      overrides.providers ?? (emptyService as ServiceInstances['providers']),
    models: overrides.models ?? (emptyService as ServiceInstances['models']),
    assistants:
      overrides.assistants ?? (emptyService as ServiceInstances['assistants']),
    dialog: overrides.dialog ?? (emptyService as ServiceInstances['dialog']),
    opener: overrides.opener ?? (emptyService as ServiceInstances['opener']),
    updater: overrides.updater ?? (emptyService as ServiceInstances['updater']),
    path: overrides.path ?? (emptyService as ServiceInstances['path']),
    core: overrides.core ?? (emptyService as ServiceInstances['core']),
    deeplink:
      overrides.deeplink ?? (emptyService as ServiceInstances['deeplink']),
    projects:
      overrides.projects ?? (emptyService as ServiceInstances['projects']),
    rag: overrides.rag ?? (emptyService as ServiceInstances['rag']),
    uploads: overrides.uploads ?? (emptyService as ServiceInstances['uploads']),
  }

  return {
    theme: () => services.theme,
    window: () => services.window,
    events: () => services.events,
    hardware: () => services.hardware,
    app: () => services.app,
    analytic: () => services.analytic,
    messages: () => services.messages,
    mcp: () => services.mcp,
    threads: () => services.threads,
    providers: () => services.providers,
    models: () => services.models,
    assistants: () => services.assistants,
    dialog: () => services.dialog,
    opener: () => services.opener,
    updater: () => services.updater,
    path: () => services.path,
    core: () => services.core,
    deeplink: () => services.deeplink,
    projects: () => services.projects,
    rag: () => services.rag,
    uploads: () => services.uploads,
  }
}

export function seedServiceHub(
  overrides: ServiceHubOverrides = {}
): ServiceHub {
  const serviceHub = createMockServiceHub(overrides)
  initializeServiceHubStore(serviceHub)
  return serviceHub
}

export function resetServiceHubStore(): void {
  useServiceStore.setState({ serviceHub: null })
}
