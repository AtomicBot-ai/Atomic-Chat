import { beforeEach, describe, expect, it } from 'vitest'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { localStorageKey } from '@/constants/localStorage'
import { useAgentMode } from '@/hooks/useAgentMode'

describe('useAgentMode', () => {
  beforeEach(() => {
    useAgentMode.getState().clearAll()
  })

  it('moves the Home composer state to the created thread', () => {
    useAgentMode.getState().setApprovalMode(TEMPORARY_CHAT_ID, 'skip')
    useAgentMode.getState().setWorkingDir(TEMPORARY_CHAT_ID, '/workspace')

    useAgentMode.getState().transferThreadState(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().getApprovalMode('thread-1')).toBe('skip')
    expect(useAgentMode.getState().getWorkingDir('thread-1')).toBe('/workspace')
    expect(useAgentMode.getState().getApprovalMode(TEMPORARY_CHAT_ID)).toBe(
      'manual'
    )
    expect(useAgentMode.getState().getWorkingDir(TEMPORARY_CHAT_ID)).toBe(
      undefined
    )
  })

  it('transfer with no composer state leaves the target on defaults', () => {
    useAgentMode.getState().transferThreadState(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().getApprovalMode('thread-1')).toBe('manual')
    expect(useAgentMode.getState().getWorkspace('thread-1')).toEqual({
      externalRoots: [],
    })
  })

  it('transfer clears stale state on the target thread', () => {
    useAgentMode.getState().setApprovalMode('thread-1', 'skip')

    useAgentMode.getState().transferThreadState(TEMPORARY_CHAT_ID, 'thread-1')

    expect(useAgentMode.getState().getApprovalMode('thread-1')).toBe('manual')
  })

  it('moves primary and external roots from Home to the created thread', () => {
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

    useAgentMode.getState().transferThreadState(TEMPORARY_CHAT_ID, 'thread-1')

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

  it('drops the retired chat/agent split in the v3 migration', async () => {
    localStorage.setItem(
      localStorageKey.agentMode,
      JSON.stringify({
        state: {
          agentThreads: { 'thread-1': true, 'thread-2': false },
          approvalModes: { 'thread-1': 'skip' },
          workspaces: {
            'thread-1': {
              primaryRoot: {
                rootId: 'root-1',
                path: '/workspace',
                name: 'workspace',
                canEdit: true,
              },
              externalRoots: [],
            },
          },
          sidebarMode: 'agent',
        },
        version: 2,
      })
    )

    await useAgentMode.persist.rehydrate()

    // Approval modes and workspaces survive; the split does not.
    expect(useAgentMode.getState().getApprovalMode('thread-1')).toBe('skip')
    expect(useAgentMode.getState().getWorkingDir('thread-1')).toBe('/workspace')
    const persisted = JSON.parse(
      localStorage.getItem(localStorageKey.agentMode) ?? '{}'
    )
    expect(persisted.state.agentThreads).toBeUndefined()
    expect(persisted.state.sidebarMode).toBeUndefined()
  })
})
