import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspacePreviewStore } from './workspace-preview-store'

describe('useWorkspacePreviewStore', () => {
  beforeEach(() => {
    useWorkspacePreviewStore.getState().reset()
  })

  it('replaces the current file tab when another file opens', () => {
    const store = useWorkspacePreviewStore.getState()
    store.openFile({
      rootId: 'project',
      rootPath: '/workspace',
      relativePath: 'src/index.ts',
    })
    store.openFile({
      rootId: 'project',
      rootPath: '/workspace',
      relativePath: 'README.md',
    })

    expect(useWorkspacePreviewStore.getState().tabs).toEqual([
      {
        id: 'file:project:README.md',
        kind: 'file',
        rootId: 'project',
        rootPath: '/workspace',
        relativePath: 'README.md',
        name: 'README.md',
      },
    ])
    expect(useWorkspacePreviewStore.getState().activeTabId).toBe(
      'file:project:README.md'
    )
  })

  it('keeps the artifact tab when replacing a file tab', () => {
    const store = useWorkspacePreviewStore.getState()
    store.openArtifact('Artifact')
    store.openFile({
      rootId: 'project',
      rootPath: '/workspace',
      relativePath: 'one.txt',
    })
    store.openFile({
      rootId: 'external',
      rootPath: '/external',
      relativePath: 'two.txt',
    })

    expect(useWorkspacePreviewStore.getState().tabs).toEqual([
      { id: 'artifact', kind: 'artifact', name: 'Artifact' },
      {
        id: 'file:external:two.txt',
        kind: 'file',
        rootId: 'external',
        rootPath: '/external',
        relativePath: 'two.txt',
        name: 'two.txt',
      },
    ])
    expect(useWorkspacePreviewStore.getState().activeTabId).toBe(
      'file:external:two.txt'
    )
  })

  it('keeps a single artifact tab and updates its label', () => {
    const store = useWorkspacePreviewStore.getState()
    store.openArtifact('First')
    store.openArtifact('Second')

    expect(useWorkspacePreviewStore.getState().tabs).toEqual([
      { id: 'artifact', kind: 'artifact', name: 'Second' },
    ])
    expect(useWorkspacePreviewStore.getState().activeTabId).toBe('artifact')
  })

  it('uses the filename for Windows workspace paths', () => {
    useWorkspacePreviewStore.getState().openFile({
      rootId: 'windows',
      rootPath: 'C:\\Work\\Atomic-Chat',
      relativePath: 'docs\\README.md',
    })

    expect(useWorkspacePreviewStore.getState().tabs[0]).toMatchObject({
      rootId: 'windows',
      rootPath: 'C:\\Work\\Atomic-Chat',
      relativePath: 'docs\\README.md',
      name: 'README.md',
    })
  })

  it('distinguishes identical relative paths in different roots', () => {
    const store = useWorkspacePreviewStore.getState()
    store.openFile({
      rootId: 'project',
      rootPath: '/workspace',
      relativePath: 'README.md',
    })
    store.openFile({
      rootId: 'external',
      rootPath: '/external',
      relativePath: 'README.md',
    })

    expect(useWorkspacePreviewStore.getState().activeTabId).toBe(
      'file:external:README.md'
    )
  })
})
