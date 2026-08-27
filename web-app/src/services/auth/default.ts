/**
 * Default Auth Service — no backend, so nothing is ever connected.
 *
 * The web build has no place to keep an OAuth refresh token safely, so this
 * reports "not connected" rather than pretending. The Cloud page renders the
 * subscription card as unavailable off the back of it.
 */

import type { AuthService, ChatGptModel, ChatGptStatus } from './types'

const DISCONNECTED: ChatGptStatus = { connected: false }

export class DefaultAuthService implements AuthService {
  async chatgptStatus(): Promise<ChatGptStatus> {
    return DISCONNECTED
  }

  async chatgptLogin(): Promise<ChatGptStatus> {
    throw new Error('Signing in to ChatGPT requires the desktop app')
  }

  async chatgptCancelLogin(): Promise<void> {
    // No-op — nothing can be in flight here.
  }

  async chatgptLogout(): Promise<ChatGptStatus> {
    return DISCONNECTED
  }

  async chatgptModels(): Promise<ChatGptModel[]> {
    return []
  }
}
