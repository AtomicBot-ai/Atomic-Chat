import { beforeEach, describe, expect, it } from 'vitest'
import { useInitialMessage } from './useInitialMessage'

describe('useInitialMessage', () => {
  beforeEach(() => {
    useInitialMessage.setState({ byThread: {} })
  })

  it('preserves the selected agent skill until the message is consumed', () => {
    useInitialMessage.getState().set('thread-1', {
      text: 'Summarize this document',
      agentSkillName: 'pdf',
    })

    expect(useInitialMessage.getState().consume('thread-1')).toEqual({
      text: 'Summarize this document',
      agentSkillName: 'pdf',
    })
    expect(useInitialMessage.getState().consume('thread-1')).toBeUndefined()
  })
})
