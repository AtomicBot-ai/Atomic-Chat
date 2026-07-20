import { describe, it, expect } from 'vitest'
import {
  splitToolInput,
  guessBlockLanguage,
  sniffLanguageFromContent,
} from '../toolParamPreview'

describe('splitToolInput', () => {
  it('extracts multiline string params and keeps the rest compact', () => {
    const { compact, blocks } = splitToolInput({
      path: '/tmp/index.html',
      content: '<!DOCTYPE html>\n<html>\n</html>',
      overwrite: true,
    })

    expect(compact).toEqual({ path: '/tmp/index.html', overwrite: true })
    expect(blocks).toEqual([
      { key: 'content', value: '<!DOCTYPE html>\n<html>\n</html>' },
    ])
  })

  it('extracts very long single-line strings too', () => {
    const long = 'x'.repeat(500)
    const { compact, blocks } = splitToolInput({ query: long, limit: 5 })

    expect(compact).toEqual({ limit: 5 })
    expect(blocks).toEqual([{ key: 'query', value: long }])
  })

  it('returns no blocks for inputs without multiline strings', () => {
    expect(splitToolInput({ path: '/a', n: 3 })).toEqual({
      compact: null,
      blocks: [],
    })
  })

  it('returns no blocks for non-object inputs', () => {
    expect(splitToolInput('partial json string')).toEqual({
      compact: null,
      blocks: [],
    })
    expect(splitToolInput(null)).toEqual({ compact: null, blocks: [] })
    expect(splitToolInput([1, 2])).toEqual({ compact: null, blocks: [] })
  })

  it('yields null compact when every param becomes a block', () => {
    const { compact, blocks } = splitToolInput({ content: 'a\nb' })
    expect(compact).toBeNull()
    expect(blocks).toHaveLength(1)
  })
})

describe('guessBlockLanguage', () => {
  it('guesses from a path-like sibling param', () => {
    expect(guessBlockLanguage({ path: '/site/index.html' })).toBe('html')
    expect(guessBlockLanguage({ file_path: 'src/app.tsx' })).toBe('tsx')
    expect(guessBlockLanguage({ filename: 'notes.md' })).toBe('markdown')
  })

  it('ignores non-path params and unknown extensions', () => {
    expect(guessBlockLanguage({ query: 'not a path.html' })).toBe('markdown')
    expect(guessBlockLanguage({ path: '/bin/data.xyzq' })).toBe('markdown')
    expect(guessBlockLanguage(null)).toBe('markdown')
  })

  it('sniffs the content when there is no path-like sibling param', () => {
    // A `content`-only write_file is common; without sniffing this would fall
    // back to markdown and render uncoloured.
    expect(guessBlockLanguage(null, '<!DOCTYPE html>\n<html></html>')).toBe(
      'html'
    )
    expect(guessBlockLanguage({}, '{"a": 1}')).toBe('json')
  })

  it('prefers an explicit path extension over content sniffing', () => {
    expect(guessBlockLanguage({ path: 'notes.md' }, '<!DOCTYPE html>')).toBe(
      'markdown'
    )
  })
})

describe('sniffLanguageFromContent', () => {
  it('detects html', () => {
    expect(sniffLanguageFromContent('<!DOCTYPE html>\n<html>')).toBe('html')
    expect(sniffLanguageFromContent('  <html lang="en">')).toBe('html')
  })

  it('detects json, including partial json mid-stream', () => {
    expect(sniffLanguageFromContent('{"a": 1, "b": [2]}')).toBe('json')
    expect(sniffLanguageFromContent('{\n  "name": "half-writ')).toBe('json')
  })

  it('detects shebang scripts', () => {
    expect(sniffLanguageFromContent('#!/bin/bash\necho hi')).toBe('bash')
    expect(sniffLanguageFromContent('#!/usr/bin/env python\nx = 1')).toBe(
      'python'
    )
  })

  it('detects css and js/ts', () => {
    expect(sniffLanguageFromContent('.hero { color: red; }')).toBe('css')
    expect(sniffLanguageFromContent("import { x } from './y'\n")).toBe(
      'typescript'
    )
    expect(sniffLanguageFromContent('const a = 1\n')).toBe('javascript')
  })

  it('detects xml/svg and php', () => {
    expect(sniffLanguageFromContent('<?xml version="1.0"?>')).toBe('xml')
    expect(sniffLanguageFromContent('<svg viewBox="0 0 1 1">')).toBe('xml')
    expect(sniffLanguageFromContent('<?php echo 1;')).toBe('php')
  })

  it('returns null for empty or unrecognised content', () => {
    expect(sniffLanguageFromContent('')).toBeNull()
    expect(sniffLanguageFromContent('   ')).toBeNull()
    expect(sniffLanguageFromContent('just some prose here')).toBeNull()
  })
})
