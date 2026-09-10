import { describe, it, expect } from 'vitest'
import {
  extensionForLanguage,
  fileNameExtension,
  looksLikeFileName,
  matchesLanguage,
  parseFenceFilename,
  parseLeadingCommentFilename,
  resolveCodeBlockFileName,
  sanitizeFileName,
  toDownloadFileName,
} from '../codeBlockFilename'

describe('parseFenceFilename', () => {
  it('reads a quoted key/value from the info string', () => {
    expect(parseFenceFilename('title="styles.css"')).toBe('styles.css')
    expect(parseFenceFilename("filename='js/main.js'")).toBe('js/main.js')
    expect(parseFenceFilename('file=data/content.js')).toBe('data/content.js')
    expect(parseFenceFilename('name=app.py')).toBe('app.py')
  })

  it('reads a bare first token', () => {
    expect(parseFenceFilename('data/content.js')).toBe('data/content.js')
    expect(parseFenceFilename('styles.css showLineNumbers')).toBe('styles.css')
  })

  it('reads a bracketed token', () => {
    expect(parseFenceFilename('[js/main.js]')).toBe('js/main.js')
  })

  it('returns null when there is nothing filename-shaped', () => {
    expect(parseFenceFilename(undefined)).toBeNull()
    expect(parseFenceFilename('')).toBeNull()
    expect(parseFenceFilename('showLineNumbers')).toBeNull()
    expect(parseFenceFilename('{1,3-5}')).toBeNull()
  })
})

describe('parseLeadingCommentFilename', () => {
  it('reads a filename from the first line of code', () => {
    expect(parseLeadingCommentFilename('// js/main.js\nconst a = 1')).toBe(
      'js/main.js'
    )
    expect(parseLeadingCommentFilename('# app.py\nprint(1)')).toBe('app.py')
    expect(parseLeadingCommentFilename('/* styles.css */\nbody {}')).toBe(
      'styles.css'
    )
    expect(parseLeadingCommentFilename('<!-- index.html -->\n<p></p>')).toBe(
      'index.html'
    )
    expect(parseLeadingCommentFilename('// File: src/main.js\n')).toBe(
      'src/main.js'
    )
  })

  it('ignores comments that are not filenames', () => {
    expect(parseLeadingCommentFilename('// Copyright Acme Inc.\n')).toBeNull()
    expect(parseLeadingCommentFilename('#!/usr/bin/env node\n')).toBeNull()
    expect(parseLeadingCommentFilename('const a = 1')).toBeNull()
    expect(parseLeadingCommentFilename('')).toBeNull()
  })
})

describe('matchesLanguage', () => {
  it('accepts a name whose extension matches the language', () => {
    expect(matchesLanguage('styles.css', 'css')).toBe(true)
    expect(matchesLanguage('main.js', 'javascript')).toBe(true)
    expect(matchesLanguage('main.ts', 'ts')).toBe(true)
  })

  it('rejects a mismatched extension', () => {
    expect(matchesLanguage('example.com', 'javascript')).toBe(false)
    expect(matchesLanguage('notes.txt', 'css')).toBe(false)
  })

  it('does not veto when the language is unknown', () => {
    expect(matchesLanguage('anything.abc', '')).toBe(true)
    expect(matchesLanguage('anything.abc', 'brainfuck')).toBe(true)
  })
})

describe('resolveCodeBlockFileName', () => {
  it('prefers the fence declaration', () => {
    expect(
      resolveCodeBlockFileName({
        meta: 'title="styles.css"',
        code: '// other.css\nbody {}',
        language: 'css',
      })
    ).toBe('styles.css')
  })

  it('falls back to a leading comment that agrees with the language', () => {
    expect(
      resolveCodeBlockFileName({
        meta: undefined,
        code: '// js/main.js\nconst a = 1',
        language: 'javascript',
      })
    ).toBe('js/main.js')
  })

  it('rejects a leading comment that disagrees with the language', () => {
    expect(
      resolveCodeBlockFileName({
        meta: undefined,
        code: '// see example.com\nconst a = 1',
        language: 'javascript',
      })
    ).toBeNull()
  })

  it('returns null when nothing names the file', () => {
    expect(
      resolveCodeBlockFileName({ meta: '', code: 'body {}', language: 'css' })
    ).toBeNull()
  })
})

describe('sanitizeFileName', () => {
  it('strips characters that are illegal on common filesystems', () => {
    expect(sanitizeFileName('a:b*c?d"e<f>g|h.js')).toBe('a b c d e f g h.js')
    expect(sanitizeFileName('ab.js')).toBe('a b.js')
  })

  it('drops leading dots so the file is not hidden', () => {
    expect(sanitizeFileName('...hidden.js')).toBe('hidden.js')
  })

  it('returns null when nothing usable is left', () => {
    expect(sanitizeFileName('   ')).toBeNull()
    expect(sanitizeFileName('///')).toBeNull()
  })

  it('caps the length', () => {
    expect(sanitizeFileName('x'.repeat(500))?.length).toBe(120)
  })
})

describe('toDownloadFileName', () => {
  it('keeps only the basename — a save dialog rejects directories', () => {
    expect(toDownloadFileName('data/content.js', 'js', 'file')).toBe(
      'content.js'
    )
    expect(toDownloadFileName('src\\main.ts', 'ts', 'file')).toBe('main.ts')
  })

  it('uses the resolved name as-is when it already has an extension', () => {
    expect(toDownloadFileName('styles.css', 'css', 'file')).toBe('styles.css')
    expect(toDownloadFileName('types.d.ts', 'ts', 'file')).toBe('types.d.ts')
  })

  it('appends the language extension when the name has none', () => {
    expect(toDownloadFileName('Makefile', 'makefile', 'file')).toBe(
      'Makefile.makefile'
    )
  })

  it('falls back to the stem when there is no name', () => {
    expect(toDownloadFileName(null, 'css', 'file')).toBe('file.css')
    expect(toDownloadFileName(undefined, 'py', 'My Project')).toBe(
      'My Project.py'
    )
    expect(toDownloadFileName('   ', 'js', 'file')).toBe('file.js')
  })
})

describe('extensionForLanguage / fileNameExtension / looksLikeFileName', () => {
  it('maps languages to extensions with a txt fallback', () => {
    expect(extensionForLanguage('javascript')).toBe('js')
    expect(extensionForLanguage('  CSS  ')).toBe('css')
    expect(extensionForLanguage('nginx')).toBe('conf')
    expect(extensionForLanguage('totally-unknown')).toBe('txt')
  })

  it('reads the extension off a name', () => {
    expect(fileNameExtension('a/b/styles.CSS')).toBe('css')
    expect(fileNameExtension('Makefile')).toBe('')
    expect(fileNameExtension('.gitignore')).toBe('')
  })

  it('recognises filename-shaped strings only', () => {
    expect(looksLikeFileName('styles.css')).toBe(true)
    expect(looksLikeFileName('data/content.js')).toBe(true)
    expect(looksLikeFileName('Acme Inc.')).toBe(false)
    expect(looksLikeFileName('trailing.')).toBe(false)
    expect(looksLikeFileName('no-extension')).toBe(false)
  })
})
