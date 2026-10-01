/**
 * Platform Feature Configuration
 * Centralized feature flags for different platforms
 */

import { PlatformFeature } from './types'
import { isPlatformTauri, isPlatformIOS, isPlatformAndroid } from './utils'

/**
 * Desktop Tauri, not the iOS or Android shell.
 *
 * Called from getters below. Do not invoke the platform helpers while this
 * module is still evaluating: the production bundle can place this object in
 * a chunk (ProvidersAvatar) that runs before the chunk that initializes
 * isPlatformTauri / isPlatformIOS / isPlatformAndroid (useModelProvider).
 * Calling them then throws "TypeError: a is not a function" and RootLayout
 * never mounts, so #initial-loader spins forever.
 */
const isDesktopTauri = (): boolean =>
  isPlatformTauri() && !isPlatformIOS() && !isPlatformAndroid()

/**
 * Platform Features Configuration
 * Centralized feature flags for different platforms.
 * Getters keep the PlatformFeatures[feature] API but defer the helpers
 * until after both sides of that chunk cycle have initialized.
 */
export const PlatformFeatures: Record<PlatformFeature, boolean> = {
  // Hardware monitoring and GPU usage
  get [PlatformFeature.HARDWARE_MONITORING]() {
    return isDesktopTauri()
  },

  // Local model inference (llama.cpp)
  get [PlatformFeature.LOCAL_INFERENCE]() {
    return isDesktopTauri()
  },

  // Local API server
  get [PlatformFeature.LOCAL_API_SERVER]() {
    return isDesktopTauri()
  },

  // Hub/model downloads
  get [PlatformFeature.MODEL_HUB]() {
    return isDesktopTauri()
  },

  // System integrations (logs, file explorer, etc.)
  get [PlatformFeature.SYSTEM_INTEGRATIONS]() {
    return isDesktopTauri()
  },

  // HTTPS proxy
  get [PlatformFeature.HTTPS_PROXY]() {
    return isDesktopTauri()
  },

  // Default model providers (OpenAI, Anthropic, etc.) - disabled for web-only Jan builds
  get [PlatformFeature.DEFAULT_PROVIDERS]() {
    return isPlatformTauri()
  },

  // Projects management
  get [PlatformFeature.PROJECTS]() {
    return isDesktopTauri()
  },

  // Analytics and telemetry - disabled for web
  get [PlatformFeature.ANALYTICS]() {
    return isDesktopTauri()
  },

  // Web-specific automatic model selection from jan provider - enabled for web only
  get [PlatformFeature.WEB_AUTO_MODEL_SELECTION]() {
    return !isPlatformTauri()
  },

  // Model provider settings page management - disabled for web only
  get [PlatformFeature.MODEL_PROVIDER_SETTINGS]() {
    return isPlatformTauri()
  },

  // Auto-enable MCP tool permissions - enabled for web platform
  get [PlatformFeature.MCP_AUTO_APPROVE_TOOLS]() {
    return !isPlatformTauri()
  },

  // MCP servers settings page - disabled for web
  get [PlatformFeature.MCP_SERVERS_SETTINGS]() {
    return isDesktopTauri()
  },

  // Extensions settings page - disabled for web
  get [PlatformFeature.EXTENSIONS_SETTINGS]() {
    return isPlatformTauri()
  },

  // Assistant functionality - disabled for web
  get [PlatformFeature.ASSISTANTS]() {
    return isPlatformTauri()
  },

  // Shortcut
  get [PlatformFeature.SHORTCUT]() {
    return !isPlatformIOS() && !isPlatformAndroid()
  },

  // File attachments/RAG UI and tooling - desktop platforms only
  get [PlatformFeature.FILE_ATTACHMENTS]() {
    return isDesktopTauri()
  },

  // Voice input / dictation - desktop platforms only
  get [PlatformFeature.VOICE_INPUT]() {
    return isDesktopTauri()
  },

  // ChatGPT subscription sign-in. See PlatformFeature.CHATGPT_SUBSCRIPTION.
  get [PlatformFeature.CHATGPT_SUBSCRIPTION]() {
    return isDesktopTauri()
  },
}
