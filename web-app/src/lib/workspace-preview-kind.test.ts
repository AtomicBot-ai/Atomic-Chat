import { describe, expect, it } from 'vitest'
import {
  classifyWorkspacePreview,
  workspacePreviewMediaType,
} from './workspace-preview-kind'

describe('classifyWorkspacePreview', () => {
  it.each([
    ['photo.PNG', 'image'],
    ['document.pdf', 'pdf'],
    ['source.tsx', 'text'],
    ['clip.mp4', 'video'],
    ['clip.MOV', 'video'],
    ['render.webm', 'video'],
    ['voice.mp3', 'audio'],
    ['voice.m4a', 'audio'],
    ['capture.mkv', 'unsupported'],
    ['archive.zip', 'unsupported'],
    ['LICENSE', 'unsupported'],
  ] as const)('classifies %s as %s', (path, expected) => {
    expect(classifyWorkspacePreview(path)).toBe(expected)
  })
})

describe('workspacePreviewMediaType', () => {
  it.each([
    ['clip.mp4', 'video/mp4'],
    ['clip.MOV', 'video/quicktime'],
    ['voice.m4a', 'audio/mp4'],
    ['voice.ogg', 'audio/ogg'],
  ] as const)('maps %s to %s', (path, expected) => {
    expect(workspacePreviewMediaType(path)).toBe(expected)
  })

  it.each(['source.tsx', 'photo.png', 'LICENSE'])(
    'has no media type for %s',
    (path) => {
      expect(workspacePreviewMediaType(path)).toBeUndefined()
    }
  )
})
