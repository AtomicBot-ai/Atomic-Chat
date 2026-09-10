/**
 * Auth Service Types
 *
 * Sign-in flows that are not "paste an API key". The tokens themselves live in
 * the Rust backend and never reach this layer — only the status does.
 */

export interface ChatGptStatus {
  connected: boolean
  email?: string | null
  plan_type?: string | null
  /** Unix seconds. Informational; the backend refreshes on its own. */
  expires_at?: number | null
}

/** One model the connected subscription can serve. */
export interface ChatGptModel {
  id: string
  display_name: string
  context_length?: number | null
  vision: boolean
  reasoning_efforts: string[]
  /** `false` marks a slug no picker should offer — aged out, or internal. */
  listed: boolean
}

export interface AuthService {
  chatgptStatus(): Promise<ChatGptStatus>
  /** Opens the system browser and resolves once the callback is exchanged. */
  chatgptLogin(): Promise<ChatGptStatus>
  chatgptCancelLogin(): Promise<void>
  chatgptLogout(): Promise<ChatGptStatus>
  /** The account's own catalogue. Throws when it cannot be reached. */
  chatgptModels(): Promise<ChatGptModel[]>
}
