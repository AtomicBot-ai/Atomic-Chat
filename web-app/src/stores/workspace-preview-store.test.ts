import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspacePreviewStore } from './workspace-preview-store'

describe('useWorkspacePreviewStore', () => {
  beforeEach(() => {
    useWorkspacePreviewStore.getState().reset()
  })

  it('replaces the current file tab when another file opens', () => {
    const store = useWorkspacePreviewStore.getState()
    store.openFile('src/index.ts')
    store.openFile('README.md')

    expect(useWorkspacePreviewStore.getState().tabs).toEqual([
      {
        id: 'file:README.md',
        kind: 'file',
        path: 'README.md',
        name: 'README.md',
      },
    ])
    expect(useWorkspacePreviewStore.getState().activeTabId).toBe(
      'file:README.md'
    )
  })

  it('keeps the artifact tab when replacing a file tab', () => {
    const store = useWorkspacePreviewStore.getState()
    store.openArtifact('Artifact')
    store.openFile('one.txt')
    store.openFile('two.txt')

    expect(useWorkspacePreviewStore.getState().tabs).toEqual([
      { id: 'artifact', kind: 'artifact', name: 'Artifact' },
      {
        id: 'file:two.txt',
        kind: 'file',
        path: 'two.txt',
        name: 'two.txt',
      },
    ])
    expect(useWorkspacePreviewStore.getState().activeTabId).toBe('file:two.txt')
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
    useWorkspacePreviewStore
      .getState()
      .openFile('C:\\Work\\Atomic-Chat\\README.md')

    expect(useWorkspacePreviewStore.getState().tabs[0]).toMatchObject({
      path: 'C:\\Work\\Atomic-Chat\\README.md',
      name: 'README.md',
    })
  })
})
