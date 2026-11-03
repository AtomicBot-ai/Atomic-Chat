import { describe, expect, it } from 'vitest'

import {
  attachmentPreviewExtension,
  attachmentPreviewMediaType,
  classifyAttachmentPreview,
} from '../attachment-preview'

describe('classifyAttachmentPreview', () => {
  it.each([
    ['photo.PNG', 'image'],
    ['report.pdf', 'pdf'],
    ['clip.mp4', 'video'],
    ['screen.mov', 'video'],
    ['voice.mp3', 'audio'],
    ['README.md', 'markdown'],
    ['page.htm', 'html'],
    ['spec.docx', 'extracted'],
    ['budget.xlsx', 'extracted'],
    ['deck.pptx', 'extracted'],
    ['table.ods', 'extracted'],
    ['data.csv', 'text'],
    ['main.rs', 'text'],
    ['App.vue', 'text'],
    ['query.graphql', 'text'],
    ['archive.zip', 'unsupported'],
    ['Makefile', 'unsupported'],
  ])('%s → %s', (name, kind) => {
    expect(classifyAttachmentPreview(name)).toBe(kind)
  })

  it('prefers the parsed file type over the name', () => {
    expect(classifyAttachmentPreview('download', 'pdf')).toBe('pdf')
  })

  it('trusts the media type of in-memory attachments', () => {
    expect(classifyAttachmentPreview('image-1', undefined, 'image/jpeg')).toBe(
      'image'
    )
    expect(classifyAttachmentPreview('memo', undefined, 'audio/wav')).toBe(
      'audio'
    )
  })
})

describe('attachmentPreviewExtension', () => {
  it('reads the extension from a Windows path', () => {
    expect(attachmentPreviewExtension('C:\\Users\\me\\Notes.TXT')).toBe('txt')
  })

  it('has none for an extensionless name', () => {
    expect(attachmentPreviewExtension('Dockerfile')).toBe('')
  })
})

describe('attachmentPreviewMediaType', () => {
  it('maps video and audio containers', () => {
    expect(attachmentPreviewMediaType('clip.mov')).toBe('video/quicktime')
    expect(attachmentPreviewMediaType('clip.webm')).toBe('video/webm')
    expect(attachmentPreviewMediaType('voice.wav')).toBe('audio/wav')
  })

  it('keeps a known media type', () => {
    expect(attachmentPreviewMediaType('voice', undefined, 'audio/mpeg')).toBe(
      'audio/mpeg'
    )
  })

  it('has none for documents', () => {
    expect(attachmentPreviewMediaType('report.pdf')).toBeUndefined()
  })
})
