import { invoke } from '@tauri-apps/api/core'
import { DefaultChatExecService } from './default'
import type {
  ChatExecRequest,
  ChatExecResult,
  ChatExecStatus,
  SecureEnvironment,
} from './types'

export class TauriChatExecService extends DefaultChatExecService {
  async status(): Promise<ChatExecStatus> {
    return invoke<ChatExecStatus>('chat_exec_status')
  }

  async run(request: ChatExecRequest): Promise<ChatExecResult> {
    return invoke<ChatExecResult>('chat_exec_run', { request })
  }

  async cancel(callId: string): Promise<boolean> {
    return invoke<boolean>('chat_exec_cancel', { callId })
  }

  async secureEnvironments(): Promise<Record<string, SecureEnvironment>> {
    return invoke<Record<string, SecureEnvironment>>('secure_env_list')
  }

  async setSecureEnvironment(
    projectId: string,
    environment: SecureEnvironment | null
  ): Promise<void> {
    await invoke('secure_env_set', { projectId, environment })
  }
}
