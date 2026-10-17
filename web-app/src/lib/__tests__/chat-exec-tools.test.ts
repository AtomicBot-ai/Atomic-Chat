import type { UIMessage } from '@ai-sdk/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useChatExecStatus } from '@/hooks/useChatExecStatus'
import {
  chatExecOutputsForModel,
  chatExecResultText,
  chatExecTools,
  isChatExecOffered,
  offeredChatExecToolNames,
  runChatExecToolCall,
  toChatExecRequest,
  toChatExecToolOutput,
} from '@/lib/chat-exec-tools'
import { seedServiceHub } from '@/test/service-hub'
import type {
  ChatExecResult,
  ChatExecService,
  ChatExecStatus,
} from '@/services/chat-exec/types'

const platformFeatures = vi.hoisted(() => ({}) as Record<string, boolean>)
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  Object.assign(platformFeatures, actual.PlatformFeatures)
  return { ...actual, PlatformFeatures: platformFeatures }
})

const macStatus: ChatExecStatus = {
  supported: true,
  os: 'macos',
  shell: 'sh',
  languages: ['python', 'javascript', 'shell'],
  sandbox: { kind: 'none', reason: null },
  userFolders: [
    { kind: 'desktop', path: '~/Desktop' },
    { kind: 'documents', path: '~/Documents' },
  ],
}

const windowsSandboxed: ChatExecStatus = {
  supported: true,
  os: 'windows',
  shell: 'cmd',
  languages: ['python', 'powershell', 'shell'],
  sandbox: { kind: 'mxc', reason: null },
  userFolders: [{ kind: 'desktop', path: 'C:\\Users\\me\\OneDrive\\Desktop' }],
}

const result = (overrides: Partial<ChatExecResult> = {}): ChatExecResult => ({
  exitCode: 0,
  stdout: 'hello\n',
  stderr: '',
  truncated: false,
  timedOut: false,
  cancelled: false,
  sandbox: 'none',
  workdir: '/data/agent-workspace/chat/t1',
  durationMs: 12,
  ...overrides,
})

function description(status: ChatExecStatus, name: string): string {
  return chatExecTools(status).find((tool) => tool.name === name)!.description
}

describe('chatExecTools', () => {
  it('describes sh and the chat folder on macOS and Linux', () => {
    const command = description(macStatus, 'run_command')

    expect(command).toContain('runs in sh')
    expect(command).toContain('scratch folder of this chat')
    expect(command).not.toContain('Windows')
    expect(command).toContain('approves each call')
  })

  it("tells the model where the user's own folders are, so Desktop is not looked up in the scratch folder", () => {
    const command = description(macStatus, 'run_command')

    expect(command).toContain("not the user's home")
    expect(command).toContain('Desktop/notes.txt lands in it')
    expect(command).toContain(
      "The user's own folders are Desktop: ~/Desktop; Documents: ~/Documents."
    )
    expect(description(macStatus, 'run_script')).toContain('Desktop: ~/Desktop')
    expect(command).not.toContain('$HOME')
  })

  it('says how to quote a localized folder name with a space', () => {
    const command = description(
      {
        ...macStatus,
        os: 'linux',
        userFolders: [{ kind: 'desktop', path: '~/Рабочий стол' }],
      },
      'run_command'
    )

    expect(command).toContain('Desktop: ~/Рабочий стол')
    expect(command).toContain('inside quotes write "$HOME/…"')
  })

  it('names the Windows folders by full path and says an ordinary chat runs on the computer, even where MXC works', () => {
    const command = description(windowsSandboxed, 'run_command')

    expect(command).toContain('cmd.exe, not bash')
    expect(command).toContain('Desktop: C:\\Users\\me\\OneDrive\\Desktop')
    expect(command).toContain("directly on the user's Windows computer")
    expect(command).not.toContain('Windows sandbox')
  })

  it('offers only the script languages found on this machine', () => {
    const script = chatExecTools(macStatus).find(
      (tool) => tool.name === 'run_script'
    )!

    expect(
      (script.inputSchema.properties as Record<string, { enum?: string[] }>)
        .language.enum
    ).toEqual(['python', 'javascript', 'shell'])
    expect(script.description).toContain('Python, JavaScript, shell')
    expect(script.inputSchema.required).toEqual(['language', 'code'])
  })

  it('leaves run_script out when no language is available, and everything out when unsupported', () => {
    expect(
      chatExecTools({ ...macStatus, languages: [] }).map((tool) => tool.name)
    ).toEqual(['run_command'])
    expect(chatExecTools({ ...macStatus, supported: false })).toEqual([])
  })
})

describe('chatExecTools in a secure environment project', () => {
  const secure = {
    folders: [
      { path: 'D:\\Work\\Reports', canEdit: true },
      { path: 'D:\\Work\\Reference', canEdit: false },
    ],
    network: false,
    allowedMcpServers: [],
  }

  it("names the project's folders instead of the user's, each with what it allows", () => {
    for (const tool of chatExecTools(windowsSandboxed, secure)) {
      expect(tool.description).toContain(
        'D:\\Work\\Reports (can be changed); D:\\Work\\Reference (read-only)'
      )
      expect(tool.description).toContain('blocked on purpose')
      expect(tool.description).toContain('There is no internet access.')
      // The sandbox grants no folder enumeration, so `dir` cannot list them.
      expect(tool.description).toContain('`dir` and `cd` fail even on these folders')
      expect(tool.description).toContain('do @echo %~nxf')
      expect(tool.description).not.toContain('OneDrive')
      // Not even as "blocked": a project folder may live inside one of them.
      expect(tool.description).not.toMatch(/Desktop|Documents|Downloads/)
    }
  })

  it('says only the chat folder is reachable when the project has no folders', () => {
    const [command] = chatExecTools(windowsSandboxed, {
      folders: [],
      network: true,
      allowedMcpServers: [],
    })
    expect(command.description).toContain('it can reach only the chat folder.')
    expect(command.description).not.toContain('internet')
  })
})

describe('isChatExecOffered', () => {
  beforeEach(() => {
    platformFeatures.chatExec = true
    useGeneralSetting.setState({ chatExecEnabled: true })
    useChatExecStatus.setState({ status: macStatus })
  })

  it('offers the tools when the platform, the toggle and the machine allow it', () => {
    expect(isChatExecOffered()).toBe(true)
    expect([...offeredChatExecToolNames()]).toEqual([
      'run_command',
      'run_script',
    ])
  })

  it('offers nothing with the composer toggle off', () => {
    useGeneralSetting.setState({ chatExecEnabled: false })
    expect(isChatExecOffered()).toBe(false)
    expect(offeredChatExecToolNames().size).toBe(0)
  })

  it('offers nothing on a platform without commands or before the status is known', () => {
    platformFeatures.chatExec = false
    expect(isChatExecOffered()).toBe(false)

    platformFeatures.chatExec = true
    useChatExecStatus.setState({ status: null })
    expect(isChatExecOffered()).toBe(false)
  })
})

describe('toChatExecRequest', () => {
  it('turns run_command into a command request', () => {
    expect(
      toChatExecRequest('run_command', { command: 'ls -la' }, 'c1', 't1')
    ).toEqual({
      request: {
        callId: 'c1',
        threadId: 't1',
        kind: 'command',
        source: 'ls -la',
        timeoutSeconds: undefined,
      },
    })
  })

  it('turns run_script into a script request and caps the timeout', () => {
    expect(
      toChatExecRequest(
        'run_script',
        { language: 'python', code: 'print(1)', timeout_seconds: 5000 },
        'c2',
        't1'
      )
    ).toEqual({
      request: {
        callId: 'c2',
        threadId: 't1',
        kind: 'script',
        language: 'python',
        source: 'print(1)',
        timeoutSeconds: 600,
      },
    })
  })

  it('explains a malformed call instead of running it', () => {
    expect(toChatExecRequest('run_command', {}, 'c', 't')).toEqual({
      error: '`command` must be a non-empty string',
    })
    expect(
      toChatExecRequest(
        'run_script',
        { language: 'cobol', code: 'x' },
        'c',
        't'
      )
    ).toMatchObject({
      error: expect.stringContaining('`language` must be one of'),
    })
    expect(
      toChatExecRequest(
        'run_script',
        { language: 'python', code: ' ' },
        'c',
        't'
      )
    ).toEqual({ error: '`code` must be a non-empty string' })
  })
})

describe('chatExecResultText', () => {
  it('gives the exit code and each stream', () => {
    expect(chatExecResultText(result({ exitCode: 2, stderr: 'boom\n' }))).toBe(
      'Exit code: 2\n\nstdout:\nhello\n\nstderr:\nboom'
    )
  })

  it('says when a run timed out, was stopped, printed nothing or was cut', () => {
    expect(
      chatExecResultText(result({ timedOut: true, exitCode: null }))
    ).toMatch(/^Timed out and was stopped\./)
    expect(chatExecResultText(result({ cancelled: true }))).toMatch(
      /^Stopped by the user/
    )
    expect(chatExecResultText(result({ stdout: '' }))).toContain('(no output)')
    expect(chatExecResultText(result({ truncated: true }))).toContain(
      'was left out'
    )
    expect(
      chatExecResultText(
        result({
          exitCode: 1,
          hint: 'macOS blocked access to a protected location.',
        })
      )
    ).toMatch(/\n\nNote: macOS blocked access to a protected location\.$/)
  })
})

describe('chatExecOutputsForModel', () => {
  it('hands the model the text of a run and leaves other tool parts alone', () => {
    const output = toChatExecToolOutput(result())
    const messages = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-run_command',
            toolCallId: 'c1',
            state: 'output-available',
            input: { command: 'echo hello' },
            output,
          },
          {
            type: 'tool-search',
            toolCallId: 'c2',
            state: 'output-available',
            input: {},
            output: [{ type: 'text', text: 'mcp' }],
          },
        ],
      },
    ] as unknown as UIMessage[]

    const prepared = chatExecOutputsForModel(messages)
    const parts = prepared[0].parts as Array<{ output: unknown }>

    expect(parts[0].output).toBe('Exit code: 0\n\nstdout:\nhello')
    expect(parts[1].output).toEqual([{ type: 'text', text: 'mcp' }])
    // The stored message keeps the object the tool row is drawn from.
    expect((messages[0].parts[0] as { output: unknown }).output).toBe(output)
  })

  it('returns the same list when there is nothing to convert', () => {
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ] as UIMessage[]
    expect(chatExecOutputsForModel(messages)).toBe(messages)
  })
})

describe('runChatExecToolCall', () => {
  beforeEach(() => {
    seedServiceHub({
      chatExec: {
        status: vi.fn().mockResolvedValue(macStatus),
      } as unknown as ChatExecService,
    })
    platformFeatures.chatExec = true
  })

  const service = (run: ChatExecService['run']) =>
    ({
      status: vi.fn().mockResolvedValue(macStatus),
      run: vi.fn(run),
      cancel: vi.fn().mockResolvedValue(true),
    }) as unknown as ChatExecService & {
      run: ReturnType<typeof vi.fn>
      cancel: ReturnType<typeof vi.fn>
    }

  it('runs the request and keeps the result for the tool row', async () => {
    const backend = service(async () => result({ sandbox: 'mxc' }))

    const outcome = await runChatExecToolCall({
      service: backend,
      toolCallId: 'c1',
      toolName: 'run_command',
      input: { command: 'echo hello' },
      threadId: 't1',
      signal: new AbortController().signal,
    })

    expect(backend.run).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'c1', threadId: 't1', kind: 'command' })
    )
    expect(outcome).toEqual({
      output: expect.objectContaining({
        kind: 'chat-exec',
        sandbox: 'mxc',
        workdir: '/data/agent-workspace/chat/t1',
        text: 'Exit code: 0\n\nstdout:\nhello',
      }),
    })
  })

  it('stops the running process when the user presses Stop', async () => {
    const controller = new AbortController()
    let finish: (value: ChatExecResult) => void = () => undefined
    const backend = service(
      () => new Promise<ChatExecResult>((resolve) => (finish = resolve))
    )

    const pending = runChatExecToolCall({
      service: backend,
      toolCallId: 'c9',
      toolName: 'run_script',
      input: { language: 'python', code: 'import time; time.sleep(60)' },
      threadId: 't1',
      signal: controller.signal,
    })
    controller.abort()
    expect(backend.cancel).toHaveBeenCalledWith('c9')
    finish(result({ cancelled: true, exitCode: null }))

    expect(await pending).toMatchObject({
      output: { cancelled: true, text: expect.stringMatching(/^Stopped/) },
    })
  })

  it('reports a backend refusal as the tool error and never runs a malformed call', async () => {
    const failing = service(async () => {
      throw 'python is not available on this computer'
    })
    expect(
      await runChatExecToolCall({
        service: failing,
        toolCallId: 'c1',
        toolName: 'run_script',
        input: { language: 'python', code: 'print(1)' },
        threadId: 't1',
        signal: new AbortController().signal,
      })
    ).toEqual({ error: 'python is not available on this computer' })

    const untouched = service(async () => result())
    expect(
      await runChatExecToolCall({
        service: untouched,
        toolCallId: 'c2',
        toolName: 'run_command',
        input: {},
        threadId: 't1',
        signal: new AbortController().signal,
      })
    ).toEqual({ error: '`command` must be a non-empty string' })
    expect(untouched.run).not.toHaveBeenCalled()
  })
})
