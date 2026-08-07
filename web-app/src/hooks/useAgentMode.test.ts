import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { localStorageKey } from '@/constants/localStorage'
import { useAgentMode } from '@/hooks/useAgentMode'

describe('useAgentMode', () => {
  beforeEach(() => {
    useAgentMode.getState().clearAll()
  })

  it('moves the Home selection to the created thread', () => {
    useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
    useAgentMode.getState().setApprovalMode(TEMPORARY_CHAT_ID, 'skip')
    useAgentMode.getState().setWorkingDir(TEMPORARY_CHAT_ID, '/workspace')

    useAgentMode.getState().transferAgentMode(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().isAgentMode('thread-1')).toBe(true)
    expect(useAgentMode.getState().getApprovalMode('thread-1')).toBe('skip')
    expect(useAgentMode.getState().getWorkingDir('thread-1')).toBe('/workspace')
    expect(useAgentMode.getState().isAgentMode(TEMPORARY_CHAT_ID)).toBe(false)
    expect(useAgentMode.getState().getApprovalMode(TEMPORARY_CHAT_ID)).toBe(
      'manual'
    )
    expect(useAgentMode.getState().getWorkingDir(TEMPORARY_CHAT_ID)).toBe(
      undefined
    )
  })

  it('keeps a newly created Chat thread out of the agent map', () => {
    useAgentMode.getState().transferAgentMode(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().isAgentMode('thread-1')).toBe(false)
    expect(useAgentMode.getState().getApprovalMode('thread-1')).toBe('manual')
  })

  it('persists the selected sidebar mode', () => {
    useAgentMode.getState().setSidebarMode('agent')

    expect(useAgentMode.getState().sidebarMode).toBe('agent')
    expect(
      JSON.parse(localStorage.getItem(localStorageKey.agentMode) ?? '{}').state
        .sidebarMode
    ).toBe('agent')
  })

  it('does not notify subscribers when the sidebar mode is unchanged', () => {
    // Opening a thread re-asserts the current mode on every navigation, so an
    // unchanged value must not wake the whole sidebar tree.
    const listener = vi.fn()
    const unsubscribe = useAgentMode.subscribe(listener)
    const stateBefore = useAgentMode.getState()

    useAgentMode.getState().setSidebarMode('chat')
    expect(useAgentMode.getState()).toBe(stateBefore)
    expect(listener).not.toHaveBeenCalled()

    useAgentMode.getState().setSidebarMode('agent')
    expect(useAgentMode.getState().sidebarMode).toBe('agent')
    expect(listener).toHaveBeenCalledTimes(1)

    const stateAfterChange = useAgentMode.getState()
    useAgentMode.getState().setSidebarMode('agent')
    expect(useAgentMode.getState()).toBe(stateAfterChange)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('resets the sidebar mode with the Agent state', () => {
    useAgentMode.getState().setSidebarMode('agent')

    useAgentMode.getState().clearAll()

    expect(useAgentMode.getState().sidebarMode).toBe('chat')
  })

  it('moves primary and external roots from Home to the created thread', () => {
    useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
    useAgentMode.getState().setPrimaryRoot(TEMPORARY_CHAT_ID, {
      rootId: 'primary',
      path: '/workspace',
      name: 'workspace',
      canEdit: true,
    })
    useAgentMode.getState().addExternalRoot(TEMPORARY_CHAT_ID, {
      rootId: 'desktop',
      path: '/Desktop',
      name: 'Desktop',
      canEdit: true,
    })

    useAgentMode.getState().transferAgentMode(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().getWorkspace('thread-1')).toEqual({
      primaryRoot: {
        rootId: 'primary',
        path: '/workspace',
        name: 'workspace',
        canEdit: true,
      },
      externalRoots: [
        {
          rootId: 'desktop',
          path: '/Desktop',
          name: 'Desktop',
          canEdit: true,
        },
      ],
    })
    expect(useAgentMode.getState().getWorkspace(TEMPORARY_CHAT_ID)).toEqual({
      externalRoots: [],
    })
  })

  it('deduplicates external roots and excludes the primary root', () => {
    const root = {
      rootId: 'shared',
      path: '/shared',
      name: 'shared',
      canEdit: true as const,
    }
    useAgentMode.getState().addExternalRoot('thread-1', root)
    useAgentMode.getState().addExternalRoot('thread-1', root)

    expect(
      useAgentMode.getState().getWorkspace('thread-1').externalRoots
    ).toEqual([root])

    useAgentMode.getState().setPrimaryRoot('thread-1', root)
    expect(
      useAgentMode.getState().getWorkspace('thread-1').externalRoots
    ).toEqual([])
  })

  it('changes external root permission and removes the root', () => {
    const root = {
      rootId: 'downloads',
      path: '/Downloads',
      name: 'Downloads',
      canEdit: true,
    }
    useAgentMode.getState().addExternalRoot('thread-1', root)

    useAgentMode
      .getState()
      .setExternalRootPermission('thread-1', root.rootId, false)

    expect(
      useAgentMode.getState().getWorkspace('thread-1').externalRoots
    ).toEqual([{ ...root, canEdit: false }])

    useAgentMode.getState().removeExternalRoot('thread-1', root.rootId)

    expect(
      useAgentMode.getState().getWorkspace('thread-1').externalRoots
    ).toEqual([])
  })

  it('migrates external roots to editable by default', async () => {
    localStorage.setItem(
      localStorageKey.agentMode,
      JSON.stringify({
        state: {
          agentThreads: { 'thread-1': true },
          approvalModes: {},
          workspaces: {
            'thread-1': {
              externalRoots: [
                {
                  rootId: 'downloads',
                  path: '/Downloads',
                  name: 'Downloads',
                },
              ],
            },
          },
          sidebarMode: 'agent',
        },
        version: 1,
      })
    )

    await useAgentMode.persist.rehydrate()

    expect(
      useAgentMode.getState().getWorkspace('thread-1').externalRoots
    ).toEqual([
      {
        rootId: 'downloads',
        path: '/Downloads',
        name: 'Downloads',
        canEdit: true,
      },
    ])
  })

  it('migrates persisted working directories into primary roots', async () => {
    localStorage.setItem(
      localStorageKey.agentMode,
      JSON.stringify({
        state: {
          agentThreads: { 'thread-1': true },
          approvalModes: {},
          workingDirs: { 'thread-1': '/legacy/workspace' },
          sidebarMode: 'agent',
        },
        version: 0,
      })
    )

    await useAgentMode.persist.rehydrate()

    expect(useAgentMode.getState().getWorkspace('thread-1')).toEqual({
      primaryRoot: {
        rootId: 'legacy:/legacy/workspace',
        path: '/legacy/workspace',
        name: 'workspace',
        canEdit: true,
      },
      externalRoots: [],
    })
  })
})
