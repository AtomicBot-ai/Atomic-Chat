import type { AgentRunError } from '@/types/agent'

export type AgentErrorCopy = {
  titleKey: string
  bodyKey: string
}

export function agentErrorCopy(error: AgentRunError): AgentErrorCopy {
  const category = error.category.toLowerCase()
  if (category === 'budget' || category === 'context') {
    return {
      titleKey: 'chat:agentError.budgetTitle',
      bodyKey: 'chat:agentError.budgetBody',
    }
  }
  if (
    category === 'auth' ||
    /api key|unauthori[sz]ed|forbidden/i.test(error.message)
  ) {
    return {
      titleKey: 'chat:agentError.authTitle',
      bodyKey: 'chat:agentError.authBody',
    }
  }
  if (category === 'timeout') {
    return {
      titleKey: 'chat:agentError.timeoutTitle',
      bodyKey: 'chat:agentError.timeoutBody',
    }
  }
  if (category === 'loop') {
    return {
      titleKey: 'chat:agentError.loopTitle',
      bodyKey: 'chat:agentError.loopBody',
    }
  }
  return {
    titleKey: 'chat:agentError.genericTitle',
    bodyKey: 'chat:agentError.genericBody',
  }
}
