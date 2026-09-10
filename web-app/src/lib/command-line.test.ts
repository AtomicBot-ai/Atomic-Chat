import { describe, it, expect } from 'vitest'
import {
  parseCommandLine,
  joinCommandLine,
  isEnvAssignment,
} from './command-line'

const parsed = (command: string, args: string[]) => ({
  ok: true,
  command,
  args,
})

describe('parseCommandLine', () => {
  it('splits a typical npx line', () => {
    expect(
      parseCommandLine('npx -y @modelcontextprotocol/server-filesystem ~/Docs')
    ).toEqual(
      parsed('npx', ['-y', '@modelcontextprotocol/server-filesystem', '~/Docs'])
    )
  })

  it('collapses repeated spaces and tabs', () => {
    expect(parseCommandLine('uvx \t  mcp-server-fetch')).toEqual(
      parsed('uvx', ['mcp-server-fetch'])
    )
  })

  it('keeps double-quoted args with spaces intact', () => {
    expect(parseCommandLine('node "/path/with spaces/i.js"')).toEqual(
      parsed('node', ['/path/with spaces/i.js'])
    )
  })

  it('treats single quotes literally (no expansion)', () => {
    expect(parseCommandLine("sh -c 'echo $HOME'")).toEqual(
      parsed('sh', ['-c', 'echo $HOME'])
    )
  })

  it('honors escaped spaces outside quotes', () => {
    expect(parseCommandLine('cat /path/with\\ spaces')).toEqual(
      parsed('cat', ['/path/with spaces'])
    )
  })

  it('honors escaped quotes inside double quotes', () => {
    expect(parseCommandLine('echo "say \\"hi\\""')).toEqual(
      parsed('echo', ['say "hi"'])
    )
  })

  it('handles mixed quotes', () => {
    expect(parseCommandLine(`echo "it's"`)).toEqual(parsed('echo', ["it's"]))
  })

  it('preserves explicit empty args', () => {
    expect(parseCommandLine('cmd ""')).toEqual(parsed('cmd', ['']))
  })

  it('leaves unquoted Windows paths untouched', () => {
    expect(parseCommandLine('node C:\\Users\\foo\\server.js')).toEqual(
      parsed('node', ['C:\\Users\\foo\\server.js'])
    )
  })

  it('errors on unterminated quotes', () => {
    expect(parseCommandLine('echo "oops')).toEqual({
      ok: false,
      error: 'unterminated-quote',
    })
    expect(parseCommandLine("echo 'oops")).toEqual({
      ok: false,
      error: 'unterminated-quote',
    })
  })

  it('errors on a trailing bare backslash', () => {
    expect(parseCommandLine('echo oops\\')).toEqual({
      ok: false,
      error: 'trailing-backslash',
    })
  })

  it('errors on empty or whitespace-only input', () => {
    expect(parseCommandLine('')).toEqual({ ok: false, error: 'empty' })
    expect(parseCommandLine('   \t ')).toEqual({ ok: false, error: 'empty' })
  })
})

describe('isEnvAssignment', () => {
  it('detects env-style prefixes', () => {
    expect(isEnvAssignment('FOO=bar')).toBe(true)
    expect(isEnvAssignment('_A=')).toBe(true)
    expect(isEnvAssignment('FOO')).toBe(false)
    expect(isEnvAssignment('1X=2')).toBe(false)
  })
})

describe('joinCommandLine', () => {
  it('leaves plain tokens unquoted', () => {
    expect(joinCommandLine('npx', ['-y', 'pkg@1.0'])).toBe('npx -y pkg@1.0')
  })

  it('quotes tokens with spaces or quotes', () => {
    expect(joinCommandLine('node', ['/path/with spaces/i.js'])).toBe(
      'node "/path/with spaces/i.js"'
    )
    expect(joinCommandLine('echo', ['say "hi"'])).toBe('echo "say \\"hi\\""')
    expect(joinCommandLine('cmd', [''])).toBe('cmd ""')
  })

  it('round-trips tricky tokens through parseCommandLine', () => {
    const fixtures: Array<{ command: string; args: string[] }> = [
      { command: 'npx', args: ['-y', '@scope/pkg', '~/Docs'] },
      { command: 'node', args: ['C:\\Users\\foo bar\\server.js'] },
      { command: 'node', args: ['C:\\Users\\foo\\server.js'] },
      { command: 'echo', args: ['a\\b', 'a\\\\b', 'a\\'] },
      { command: 'echo', args: ["it's", 'say "hi"', ''] },
      { command: 'python', args: ['-c', 'print("héllo wörld")'] },
      { command: '/usr/local/bin/my server', args: ['--flag=va lue'] },
    ]
    for (const { command, args } of fixtures) {
      expect(parseCommandLine(joinCommandLine(command, args))).toEqual(
        parsed(command, args)
      )
    }
  })
})
