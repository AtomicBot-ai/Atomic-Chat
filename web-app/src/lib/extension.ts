import { AIEngine, BaseExtension, ExtensionTypeEnum } from '@janhq/core'

import { getServiceHub } from '@/hooks/useServiceHub'
import { BootLogLevel, bootLog, bootStep } from '@/lib/boot'

/**
 * How long one extension's `onLoad` may take before startup carries on
 * without it. Generous: on the slowest machine seen so far every bundled
 * extension finished inside a few seconds.
 */
export const EXTENSION_LOAD_TIMEOUT_MS = 15_000

export type ExtensionLoadFailure = {
  /** Extension name, e.g. `@janhq/llamacpp-upstream-extension`. */
  name: string
  /** It threw or rejected, or it had not finished in time. */
  reason: 'error' | 'timeout'
  message: string
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Status-line text naming what startup is still waiting for. */
function startingLabel(pending: Set<string>): string {
  const names = [...pending].map((name) =>
    name.replace(/^@janhq\//, '').replace(/-extension$/, '')
  )
  if (names.length === 0) return 'Starting extensions…'
  if (names.length > 3) return `Starting extensions… (${names.length} left)`
  return `Starting extensions… waiting for ${names.join(', ')}`
}

/**
 * Extension manifest object.
 */
export class Extension {
  /** @type {string} Name of the extension. */
  name: string

  /** @type {string} Product name of the extension. */
  productName?: string

  /** @type {string} The URL of the extension to load. */
  url: string

  /** @type {boolean} Whether the extension is activated or not. */
  active?: boolean

  /** @type {string} Extension's description. */
  description?: string

  /** @type {string} Extension's version. */
  version?: string

  /** @type {BaseExtension} Pre-loaded extension instance for web extensions. */
  extensionInstance?: BaseExtension

  constructor(
    url: string,
    name: string,
    productName?: string,
    active?: boolean,
    description?: string,
    version?: string,
    extensionInstance?: BaseExtension
  ) {
    this.name = name
    this.productName = productName
    this.url = url
    this.active = active
    this.description = description
    this.version = version
    this.extensionInstance = extensionInstance
  }
}

export type ExtensionManifest = {
  url: string
  name: string
  productName?: string
  active?: boolean
  description?: string
  version?: string
  extensionInstance?: BaseExtension // For web extensions
}

/**
 * Manages the registration and retrieval of extensions.
 */
export class ExtensionManager {
  date = new Date().toISOString()
  // Registered extensions
  private extensions = new Map<string, BaseExtension>()

  // Registered inference engines
  private engines = new Map<string, AIEngine>()

  // Extensions that failed to register or load during this startup
  private failures: ExtensionLoadFailure[] = []

  /**
   * Registers an extension.
   * @param extension - The extension to register.
   */
  register<T extends BaseExtension>(name: string, extension: T) {
    // Register for naming use
    this.extensions.set(name, extension)

    // Register AI Engines
    if ('provider' in extension && typeof extension.provider === 'string') {
      this.engines.set(
        extension.provider as unknown as string,
        extension as unknown as AIEngine
      )
    }
  }

  /**
   * Retrieves a extension by its type.
   * @param type - The type of the extension to retrieve.
   * @returns The extension, if found.
   */
  get<T extends BaseExtension>(type: ExtensionTypeEnum): T | undefined {
    return this.getAll().find((e) => e.type() === type) as T | undefined
  }

  /**
   * Retrieves a extension by its type.
   * @param type - The type of the extension to retrieve.
   * @returns The extension, if found.
   */
  getByName(name: string): BaseExtension | undefined {
    return this.extensions.get(name) as BaseExtension | undefined
  }

  /**
   * Retrieves a extension by its type.
   * @param type - The type of the extension to retrieve.
   * @returns The extension, if found.
   */
  getAll(): BaseExtension[] {
    return Array.from(this.extensions.values())
  }

  /**
   * Retrieves a extension by its type.
   * @param engine - The engine name to retrieve.
   * @returns The extension, if found.
   */
  getEngine<T extends AIEngine>(engine: string): T | undefined {
    return this.engines.get(engine) as T | undefined
  }

  /**
   * Loads all registered extensions.
   *
   * Each `onLoad` is isolated: one that throws, or that has not finished
   * within {@link EXTENSION_LOAD_TIMEOUT_MS}, is recorded in
   * {@link getLoadFailures} and startup carries on without waiting for it.
   * This used to be a bare `Promise.all`, so a single extension that threw
   * left the whole app undrawn, and one that never resolved held it there
   * for good. A timed-out `onLoad` keeps running; app.log says if it finishes
   * late. Never rejects.
   */
  async load() {
    const pending = new Set(this.extensions.keys())
    bootStep('extensions:load', startingLabel(pending))
    await Promise.all(
      [...this.extensions.entries()].map(async ([name, extension]) => {
        await this.loadOne(name, extension)
        pending.delete(name)
        if (pending.size > 0) {
          bootStep(`extensions:loaded:${name}`, startingLabel(pending))
        }
      })
    )
  }

  private async loadOne(name: string, extension: BaseExtension) {
    const startedAt = Date.now()
    // `onLoad` is typed as returning void; most return a promise, and one that
    // throws synchronously must be caught just the same.
    const loading = Promise.resolve().then(() => extension.onLoad())
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      loading.then(
        () => ({ status: 'loaded' as const }),
        (error: unknown) => ({ status: 'error' as const, error })
      ),
      new Promise<{ status: 'timeout' }>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'timeout' }),
          EXTENSION_LOAD_TIMEOUT_MS
        )
      }),
    ])
    clearTimeout(timer)
    const ms = Date.now() - startedAt

    if (outcome.status === 'loaded') {
      bootLog(`extension ${name} loaded in ${ms} ms`)
      return
    }
    if (outcome.status === 'error') {
      const message = describeError(outcome.error)
      console.error(`Extension '${name}' failed to load:`, outcome.error)
      bootLog(
        `extension ${name} failed to load after ${ms} ms: ${message}`,
        BootLogLevel.error
      )
      this.failures.push({ name, reason: 'error', message })
      return
    }
    console.warn(
      `Extension '${name}' has not finished loading after ${ms} ms; continuing without it`
    )
    bootLog(
      `extension ${name} still loading after ${ms} ms; startup continues without it`,
      BootLogLevel.warn
    )
    this.failures.push({
      name,
      reason: 'timeout',
      message: `did not finish loading within ${Math.round(EXTENSION_LOAD_TIMEOUT_MS / 1000)} s`,
    })
    void loading.then(
      () =>
        bootLog(
          `extension ${name} finished loading late, after ${Date.now() - startedAt} ms`
        ),
      (error: unknown) =>
        bootLog(
          `extension ${name} failed late, after ${Date.now() - startedAt} ms: ${describeError(error)}`,
          BootLogLevel.error
        )
    )
  }

  /**
   * Extensions that failed to register or to load during this startup, or
   * that were still loading when startup carried on without them.
   */
  getLoadFailures(): ExtensionLoadFailure[] {
    return [...this.failures]
  }

  /**
   * Unloads all registered extensions.
   */
  unload() {
    this.listExtensions().forEach((ext) => {
      ext.onUnload()
    })
  }

  /**
   * Retrieves a list of all registered extensions.
   * @returns An array of extensions.
   */
  listExtensions() {
    return [...this.extensions.values()]
  }

  /**
   * Retrieves a list of all registered extensions.
   * @returns An array of extensions.
   */
  async getActive(): Promise<Extension[]> {
    const manifests = await getServiceHub().core().getActiveExtensions()
    if (!manifests || !Array.isArray(manifests)) return []

    const extensions: Extension[] = manifests.map((manifest: ExtensionManifest) => {
      return new Extension(
        manifest.url,
        manifest.name,
        manifest.productName,
        manifest.active,
        manifest.description,
        manifest.version,
        manifest.extensionInstance // Pass the extension instance if available
      )
    })
    
    return extensions
  }

  /**
   * Register a extension with its class.
   * @param {Extension} extension extension object as provided by the main process.
   * @returns {void}
   */
  async activateExtension(extension: Extension) {
    // Check if extension already has a pre-loaded instance (web extensions)
    if (extension.extensionInstance) {
      this.register(extension.name, extension.extensionInstance)
      console.log(`Extension '${extension.name}' registered with pre-loaded instance`)
      return
    }
    
    // Import class for Tauri extensions
    const extensionUrl = extension.url
    await import(/* @vite-ignore */ getServiceHub().core().convertFileSrc(extensionUrl)).then(
      (extensionClass) => {
        // Register class if it has a default export
        if (
          typeof extensionClass.default === 'function' &&
          extensionClass.default.prototype
        ) {
          this.register(
            extension.name,
            new extensionClass.default(
              extension.url,
              extension.name,
              extension.productName,
              extension.active,
              extension.description,
              extension.version
            )
          )
        }
      }
    )
  }

  /**
   * Registers all active extensions.
   * @returns {void}
   */
  async registerActive() {
    // Get active extensions. If the list itself cannot be read, the app still
    // starts - with no extensions - instead of staying undrawn.
    let activeExtensions: Extension[] = []
    try {
      activeExtensions = (await this.getActive()) ?? []
    } catch (error) {
      const message = describeError(error)
      console.error('Could not read the active extensions:', error)
      bootLog(
        `could not read the active extensions: ${message}`,
        BootLogLevel.error
      )
      this.failures.push({ name: 'extensions.json', reason: 'error', message })
      return
    }
    bootLog(
      `registering ${activeExtensions.length} extension(s): ${activeExtensions
        .map((ext) => ext.name)
        .join(', ')}`
    )
    // Activate all. One that fails to import is recorded and skipped; it used
    // to reject the whole batch, so no extension at all got registered.
    const results = await Promise.allSettled(
      activeExtensions.map((ext: Extension) => this.activateExtension(ext))
    )
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      const name = activeExtensions[index]?.name ?? `extension #${index}`
      const message = describeError(result.reason)
      console.error(`Extension '${name}' failed to register:`, result.reason)
      bootLog(
        `extension ${name} failed to register: ${message}`,
        BootLogLevel.error
      )
      this.failures.push({ name, reason: 'error', message })
    })
  }

  /**
   * Install a new extension.
   * @param {Array.<installOptions | string>} extensions A list of NPM specifiers, or installation configuration objects.
   * @returns {Promise.<Array.<Extension> | false>} extension as defined by the main process. Has property cancelled set to true if installation was cancelled in the main process.
   */
  async install(extensions: ExtensionManifest[]) {
    if (typeof window === 'undefined') {
      return
    }
    const res = await getServiceHub().core().installExtension(extensions)
    return res.map(async (ext: ExtensionManifest) => {
      const extension = new Extension(ext.name, ext.url)
      await this.activateExtension(extension)
      return extension
    })
  }

  /**
   * Uninstall provided extensions
   * @param {Array.<string>} extensions List of names of extensions to uninstall.
   * @param {boolean} reload Whether to reload all renderers after updating the extensions.
   * @returns {Promise.<boolean>} Whether uninstalling the extensions was successful.
   */
  async uninstall(extensions: string[], reload = true) {
    if (typeof window === 'undefined') {
      return
    }
    return await getServiceHub().core().uninstallExtension(extensions, reload)
  }

  /**
   * Shared instance of ExtensionManager.
   */
  static getInstance() {
    if (!window.core.extensionManager)
      window.core.extensionManager = new ExtensionManager()
    return window.core.extensionManager as ExtensionManager
  }
}
