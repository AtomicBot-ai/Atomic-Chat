/**
 * Tauri Auth Service — desktop implementation.
 *
 * Every method is a command round trip; no token ever crosses this boundary.
 * `chatgpt_login` is long-running by design: it resolves only once the browser
 * callback has been received and exchanged.
 */

import { invoke } from '@tauri-apps/api/core'
import { DefaultAuthService } from './default'
import type { ChatGptModel, ChatGptStatus } from './types'

export class TauriAuthService extends DefaultAuthService {
  async chatgptStatus(): Promise<ChatGptStatus> {
    return await invoke<ChatGptStatus>('chatgpt_status')
  }

  async chatgptLogin(): Promise<ChatGptStatus> {
    return await invoke<ChatGptStatus>('chatgpt_login')
  }

  async chatgptCancelLogin(): Promise<void> {
    await invoke('chatgpt_cancel_login')
  }

  async chatgptLogout(): Promise<ChatGptStatus> {
    return await invoke<ChatGptStatus>('chatgpt_logout')
  }

  async chatgptModels(): Promise<ChatGptModel[]> {
    return await invoke<ChatGptModel[]>('chatgpt_models')
  }
}
