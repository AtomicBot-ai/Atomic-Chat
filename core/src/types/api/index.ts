import { ChatCompletionMessage } from '../inference'

/**
 * Native Route APIs
 * @description Enum of all the routes exposed by the app
 */
export enum NativeRoute {
  openExternalUrl = 'openExternalUrl',
  openAppDirectory = 'openAppDirectory',
  openFileExplore = 'openFileExplorer',
  selectDirectory = 'selectDirectory',
  selectFiles = 'selectFiles',
  relaunch = 'relaunch',
  setNativeThemeLight = 'setNativeThemeLight',
  setNativeThemeDark = 'setNativeThemeDark',

  setMinimizeApp = 'setMinimizeApp',
  setCloseApp = 'setCloseApp',
  setMaximizeApp = 'setMaximizeApp',
  showOpenMenu = 'showOpenMenu',

  hideQuickAskWindow = 'hideQuickAskWindow',
  sendQuickAskInput = 'sendQuickAskInput',

  hideMainWindow = 'hideMainWindow',
  showMainWindow = 'showMainWindow',

  quickAskSizeUpdated = 'quickAskSizeUpdated',
  ackDeepLink = 'ackDeepLink',
  factoryReset = 'factoryReset',

  startServer = 'startServer',
  stopServer = 'stopServer',

  appUpdateDownload = 'appUpdateDownload',

  appToken = 'appToken',
}

/**
 * App Route APIs
 * @description Enum of all the routes exposed by the app
 */
export enum AppRoute {
  getAppConfigurations = 'getAppConfigurations',
  updateAppConfiguration = 'updateAppConfiguration',
  joinPath = 'joinPath',
  dirName = 'dirName',
  isSubdirectory = 'isSubdirectory',
  baseName = 'baseName',
  log = 'log',
  showToast = 'showToast',
}

export enum AppEvent {
  onAppUpdateNotAvailable = 'onAppUpdateNotAvailable',
  onAppUpdateAvailable = 'onAppUpdateAvailable',
  onAppUpdateDownloadUpdate = 'onAppUpdateDownloadUpdate',
  onAppUpdateDownloadError = 'onAppUpdateDownloadError',
  onAppUpdateDownloadSuccess = 'onAppUpdateDownloadSuccess',
  onModelImported = 'onModelImported',

  onBackendDownloadStarted = 'onBackendDownloadStarted',
  onBackendDownloadFinished = 'onBackendDownloadFinished',
  onBetterBackendDetected = 'onBetterBackendDetected',
  /**
   * Verdict on the backend a successful load actually ran on: it disagrees with
   * the backend the UI shows, or a faster tier is available, or all is well.
   * Emitted per load by the llama.cpp providers. A `kind: 'ok'` verdict is what
   * retires a warning the user has since fixed.
   */
  onBackendRuntimeReported = 'onBackendRuntimeReported',

  onUserSubmitQuickAsk = 'onUserSubmitQuickAsk',
  onSelectedText = 'onSelectedText',

  onDeepLink = 'onDeepLink',
  onMainViewStateChange = 'onMainViewStateChange',
}

/**
 * Identity every backend event carries so a listener can tell whose operation
 * it is watching.
 *
 * Both llama.cpp providers ship side by side and each has its own optimal
 * backend for the same hardware, so a payload is only actionable together with
 * the provider it came from and the release the backend belongs to. `provider`
 * is optional purely for backwards compatibility: an untagged payload is
 * attributed to `llamacpp-upstream`, which is what legacy emitters were.
 */
export interface BackendEventOrigin {
  /** Provider id, e.g. `llamacpp` (TurboQuant) or `llamacpp-upstream`. */
  provider?: string
  /** Release tag the backend belongs to, e.g. `b10018-1.3.0`. */
  version?: string
  /** Concrete clean backend id, e.g. `linux-x64-rocm`. */
  backendId?: string
}

/** Payload of {@link AppEvent.onBackendDownloadStarted}. */
export interface BackendDownloadStartedPayload extends BackendEventOrigin {
  /** Full `version/backend` string being downloaded. */
  backend: string
  status: 'downloading'
}

/** Payload of {@link AppEvent.onBackendDownloadFinished}. */
export interface BackendDownloadFinishedPayload extends BackendEventOrigin {
  backend: string
  status: 'completed' | 'failed'
  error?: string
}

/**
 * Payload of {@link AppEvent.onBetterBackendDetected} and of the manual
 * download events the provider settings page drives.
 */
export interface BetterBackendDetectedPayload extends BackendEventOrigin {
  currentBackend: string
  recommendedBackend: string
  recommendedCategory: string
}

/**
 * `detail` of the `app:backend-hotswapped` DOM event an extension dispatches
 * after activating a backend without a restart. It travels on the window
 * rather than the `@janhq/core` bus because it only drives UI transitions.
 */
export interface BackendHotswappedDetail extends BackendEventOrigin {
  /** Full `version/backend` string now active. */
  backend: string
}

export enum DownloadEvent {
  onFileDownloadUpdate = 'onFileDownloadUpdate',
  onFileDownloadError = 'onFileDownloadError',
  onFileDownloadSuccess = 'onFileDownloadSuccess',
  onFileDownloadStopped = 'onFileDownloadStopped',
  onFileDownloadStarted = 'onFileDownloadStarted',
  onModelValidationStarted = 'onModelValidationStarted',
  onModelValidationFailed = 'onModelValidationFailed',
  onFileDownloadAndVerificationSuccess = 'onFileDownloadAndVerificationSuccess',
}
export enum ExtensionRoute {
  baseExtensions = 'baseExtensions',
  getActiveExtensions = 'getActiveExtensions',
  installExtension = 'installExtension',
  invokeExtensionFunc = 'invokeExtensionFunc',
  updateExtension = 'updateExtension',
  uninstallExtension = 'uninstallExtension',
}
export enum FileSystemRoute {
  appendFileSync = 'appendFileSync',
  unlinkSync = 'unlinkSync',
  existsSync = 'existsSync',
  readdirSync = 'readdirSync',
  rm = 'rm',
  mv = 'mv',
  mkdir = 'mkdir',
  readFileSync = 'readFileSync',
  writeFileSync = 'writeFileSync',
}
export enum FileManagerRoute {
  copyFile = 'copyFile',
  getJanDataFolderPath = 'getJanDataFolderPath',
  getResourcePath = 'getResourcePath',
  getUserHomePath = 'getUserHomePath',
  fileStat = 'fileStat',
  writeBlob = 'writeBlob',
  getGgufFiles = 'getGgufFiles',
}

export type ApiFunction = (...args: any[]) => any

export type NativeRouteFunctions = {
  [K in NativeRoute]: ApiFunction
}

export type AppRouteFunctions = {
  [K in AppRoute]: ApiFunction
}

export type AppEventFunctions = {
  [K in AppEvent]: ApiFunction
}

export type DownloadEventFunctions = {
  [K in DownloadEvent]: ApiFunction
}

export type ExtensionRouteFunctions = {
  [K in ExtensionRoute]: ApiFunction
}

export type FileSystemRouteFunctions = {
  [K in FileSystemRoute]: ApiFunction
}

export type FileManagerRouteFunctions = {
  [K in FileManagerRoute]: ApiFunction
}

export type APIFunctions = NativeRouteFunctions &
  AppRouteFunctions &
  AppEventFunctions &
  DownloadEventFunctions &
  ExtensionRouteFunctions &
  FileSystemRouteFunctions &
  FileManagerRoute

export const CoreRoutes = [
  ...Object.values(AppRoute),
  ...Object.values(ExtensionRoute),
  ...Object.values(FileSystemRoute),
  ...Object.values(FileManagerRoute),
  'launchClaudeCodeWithConfig',
  'writeEnvFileToConfig',
]

export const APIRoutes = [...CoreRoutes, ...Object.values(NativeRoute)]
export const APIEvents = [...Object.values(AppEvent), ...Object.values(DownloadEvent)]
export type PayloadType = {
  messages: ChatCompletionMessage[]
  model: string
  stream: boolean
}
