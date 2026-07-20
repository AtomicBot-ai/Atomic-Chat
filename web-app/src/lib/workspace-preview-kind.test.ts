import { describe, expect, it } from 'vitest'
import { classifyWorkspacePreview } from './workspace-preview-kind'

describe('classifyWorkspacePreview', () => {
  it.each([
    ['photo.PNG', 'image'],
    ['document.pdf', 'pdf'],
    ['source.tsx', 'text'],
    ['archive.zip', 'unsupported'],
    ['LICENSE', 'unsupported'],
  ] as const)('classifies %s as %s', (path, expected) => {
    expect(classifyWorkspacePreview(path)).toBe(expected)
  })
})
