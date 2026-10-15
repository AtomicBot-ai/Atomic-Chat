/**
 * Default Chat Exec Service — web and mobile, where chat cannot run anything.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import {
  UNSUPPORTED_CHAT_EXEC_STATUS,
  type ChatExecRequest,
  type ChatExecResult,
  type ChatExecService,
  type ChatExecStatus,
} from './types'

export class DefaultChatExecService implements ChatExecService {
  async status(): Promise<ChatExecStatus> {
    return UNSUPPORTED_CHAT_EXEC_STATUS
  }

  async run(_request: ChatExecRequest): Promise<ChatExecResult> {
    throw new Error('Running commands is not available on this platform')
  }

  async cancel(_callId: string): Promise<boolean> {
    return false
  }
}
