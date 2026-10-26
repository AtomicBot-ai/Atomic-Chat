import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutEffect } from 'react'
import ChatInput from '../ChatInput'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import { useAttachments } from '@/hooks/useAttachments'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelLoad } from '@/hooks/useModelLoad'
import { modelStopKey, useAppState } from '@/hooks/useAppState'
import { usePrompt } from '@/hooks/usePrompt'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAgentRun } from '@/hooks/useAgentRun'
import { useThreads } from '@/hooks/useThreads'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useVoiceInput } from '@/hooks/useVoiceInput'
import { useDeferredFirstSend } from '@/stores/deferred-first-send-store'
import { seedServiceHub } from '@/test/service-hub'
import type { ServiceHub } from '@/services'
import type { AgentSkill } from '@/services/agent/skills'

// Agent mode is hidden in the product (PlatformFeature.AGENT_MODE is off);
// these tests exercise it, so the feature is on here and individual tests
// flip it back off. Mutable on purpose: PlatformFeatures is read at render.
const platformFeatures = vi.hoisted(() => ({}) as Record<string, boolean>)
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/platform/const')>()
  Object.assign(platformFeatures, actual.PlatformFeatures, {
    agentMode: true,
    chatExec: true,
  })
  return { ...actual, PlatformFeatures: platformFeatures }
})

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  message: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

// The paperclip opens the native picker only in the desktop app; the web
// build clicks a hidden file input instead. Tests pick the desktop path.
const platform = vi.hoisted(() => ({ tauri: true }))
vi.mock('@/lib/platform/utils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/platform/utils')>()
  return { ...actual, isPlatformTauri: () => platform.tauri }
})

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  downscaleImageDataUrl: vi.fn(),
  switchToModel: vi.fn(),
  chatBusy: false,
  agentSkills: [] as AgentSkill[],
  replyGateProps: null as {
    onResolved: (resolution: unknown) => void
    onDismissed: (resolution: unknown) => void
  } | null,
}))

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
  shouldAttemptAutoStart: () => true,
  isExplicitSwitchPending: () => false,
}))

vi.mock('@/stores/chat-session-store', () => ({
  isAnyChatBusy: () => mocks.chatBusy,
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: mocks.navigate }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/imageDownscale', () => ({
  downscaleImageDataUrl: mocks.downscaleImageDataUrl,
}))

vi.mock('react-textarea-autosize', async () => {
  const React = await import('react')
  type AutosizeProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    minRows?: number
    maxRows?: number
  }
  return {
    default: React.forwardRef<HTMLTextAreaElement, AutosizeProps>(
      ({ minRows, maxRows, ...props }, ref) => {
        void maxRows
        return <textarea {...props} data-min-rows={minRows} ref={ref} />
      }
    ),
  }
})

vi.mock('@/hooks/useTools', () => ({
  useTools: vi.fn(),
}))

vi.mock('@/hooks/useAgentSkills', () => ({
  useAgentSkills: () => ({
    skills: mocks.agentSkills,
    loading: false,
    setEnabled: vi.fn(),
  }),
}))

vi.mock('@/hooks/useAgentMode', () => {
  const state = {
    approvalModes: {} as Record<string, string>,
    workspaces: {} as Record<string, unknown>,
    setApprovalMode: vi.fn(),
  }
  const useAgentMode = (selector: (value: typeof state) => unknown) =>
    selector(state)
  useAgentMode.getState = () => state
  return { useAgentMode }
})

vi.mock('@/hooks/useJanBrowserExtension', () => ({
  useJanBrowserExtension: () => ({
    isActive: false,
    dialogOpen: false,
    dialogState: null,
    toggleBrowser: vi.fn(),
    handleCancel: vi.fn(),
    setDialogOpen: vi.fn(),
  }),
}))

vi.mock('@/containers/chatInput/useTauriDragDrop', () => ({
  useTauriDragDrop: vi.fn(),
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({ get: () => undefined }),
  },
}))

// Render menus inline so the attach-menu items are queryable without
// driving Radix pointer events through jsdom.
vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react')
  type WithChildren = { children?: React.ReactNode }
  const passthrough = ({ children }: WithChildren) => <div>{children}</div>
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuItem: ({
      children,
      onClick,
      ...props
    }: WithChildren & { onClick?: () => void }) => (
      <button onClick={onClick} {...props}>
        {children}
      </button>
    ),
  }
})

vi.mock('@/containers/DropdownPlugins', () => ({
  // A marker instead of null: the toolbar asserts the plugins button is there.
  default: () => <span data-test-id="connectors-dropdown" />,
}))

vi.mock('@/containers/VoiceInputToggle', () => ({
  // A marker rather than null: the composer's placement of the microphone is
  // asserted below, and that needs something in the DOM to locate.
  default: () => <button data-test-id="voice-input-toggle" />,
}))

vi.mock('@/containers/chatInput/VoiceRecordingBar', () => ({
  default: () => null,
}))

vi.mock('@/containers/DropdownModelProvider', () => ({
  // The model pill; likewise only its place in the cluster matters here.
  default: () => <button data-test-id="model-picker-trigger" />,
}))

vi.mock('@/containers/dialogs/JanBrowserExtensionDialog', () => ({
  default: () => null,
}))

vi.mock('@/containers/dialogs/VisionModelDialog', () => ({
  // A marker while open: picking images for a model that cannot see them
  // offers a vision model, the way the old "Add Images" item did.
  VisionModelDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="vision-model-dialog" /> : null,
}))

// Stubbed to a marker that also hands the composer's callbacks back to the
// test: the widget's own suite covers its branches, and its real body fetches
// the recommended model's card from Hugging Face.
vi.mock('@/containers/ReplyModelGate', () => ({
  ReplyModelGate: (props: {
    open: boolean
    onResolved: (resolution: unknown) => void
    onDismissed: (resolution: unknown) => void
  }) => {
    mocks.replyGateProps = props
    return props.open ? <div data-testid="reply-model-gate" /> : null
  },
}))

vi.mock('@/containers/AgentApprovalModeSelect', () => ({
  // A marker: the project-composer test asserts the agent affordances render.
  // The menu's switches are rendered as plain buttons, so the composer's
  // wiring of Agent mode can be driven from here; the select's own suite
  // covers how the menu draws them.
  AgentApprovalModeSelect: ({
    toggles = [],
    manualOverride,
  }: {
    toggles?: Array<{
      id: string
      label: string
      checked: boolean
      onCheckedChange: (checked: boolean) => void
    }>
    manualOverride?: {
      notice: string
      actionLabel: string
      onAction: () => void
    }
  }) => (
    <>
      <span data-test-id="approval-mode-select">
        {toggles.map((toggle) => (
          <button
            key={toggle.id}
            aria-pressed={toggle.checked}
            onClick={() => toggle.onCheckedChange(!toggle.checked)}
          >
            {toggle.label}
          </button>
        ))}
      </span>
      {manualOverride && (
        <span data-test-id="approval-manual-override">
          {manualOverride.notice}
          <a onClick={manualOverride.onAction}>{manualOverride.actionLabel}</a>
        </span>
      )}
    </>
  ),
}))

vi.mock('@/containers/AgentExternalFolderButton', () => ({
  AgentExternalFolderButton: () => null,
}))

vi.mock('@/components/TokenCounter', () => ({
  TokenCounter: () => null,
}))

describe('ChatInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentSkills = []
    seedServiceHub()
    usePrompt.setState({ prompt: '' })
    useChatAttachments.setState({ attachmentsByThread: {} })
    useGeneralSetting.setState({ agentModeEnabled: false })
    platformFeatures.agentMode = true
    platformFeatures.chatExec = true
    platform.tauri = true
    useAttachments.setState({ enabled: true })
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      pausedDownloads: new Set(),
      resumeParams: {},
    })
    useDeferredFirstSend.setState({ queued: null })
    useModelLoad.getState().setModelLoadError(undefined)

    const model = {
      id: 'test-model',
      capabilities: [],
      settings: {},
    } as Model
    const provider = {
      provider: 'openai',
      active: true,
      models: [model],
      settings: [],
    } as ModelProvider
    useModelProvider.setState({
      providers: [provider],
      selectedProvider: 'openai',
      selectedModel: model,
    })
  })

  it('docks pending folder access to the same surface as the composer', () => {
    const previousThreadId = useThreads.getState().currentThreadId
    useThreads.setState({ currentThreadId: 'approval-layout' })
    useAgentRun.getState().startRun('approval-layout', 'run-1')
    useAgentRun.getState().applyEvent('approval-layout', {
      type: 'folder_access_requested',
      run_id: 'run-1',
      access_id: 'access-1',
      tool: 'os.fs.read',
      path: '/Users/me/project',
      display_name: 'project',
      root_id: 'root-1',
      reason: 'outside the workspace',
    })
    const { unmount } = render(<ChatInput chatStatus="submitted" />)
    const card = screen.getByTestId('agent-approval-inline')
    const composer = screen.getByTestId('chat-input').closest('.border-input')!
    expect(card.parentElement).toBe(composer.parentElement)
    expect(card).toHaveClass('bg-muted', 'absolute', 'bottom-full')
    expect(screen.getByText('/Users/me/project')).toBeVisible()
    expect(screen.getByText('agentFolderAccess.canEditNotice')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'agentFolderAccess.allow' })
    ).toBeEnabled()
    unmount()
    useAgentRun.getState().clearAll()
    useThreads.setState({ currentThreadId: previousThreadId })
  })

  it('renders the production input with its translated placeholder', () => {
    const { unmount } = render(<ChatInput />)

    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'placeholder',
      'common:placeholder.chatInput'
    )
    // Nothing to send yet, so there is no Send button at all.
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).not.toBeInTheDocument()
    unmount()
  })

  describe('while the voice model is starting', () => {
    const KEY = 'voice-starting-thread'

    /** Owns the microphone for this composer; `cancel` spies on the real one. */
    function startVoiceHere() {
      const previousThreadId = useThreads.getState().currentThreadId
      const realCancel = useVoiceInput.getState().cancel
      const cancel = vi.fn(() => realCancel())
      useThreads.setState({ currentThreadId: KEY })
      useVoiceInput.setState({ phase: 'starting', ownerKey: KEY, cancel })
      return {
        cancel,
        restore: () => {
          useVoiceInput.setState({ cancel: realCancel })
          useVoiceInput.getState().reset()
          useThreads.setState({ currentThreadId: previousThreadId })
        },
      }
    }

    it('does not tell the user to speak before the microphone is open', () => {
      const voice = startVoiceHere()
      try {
        const { unmount } = render(<ChatInput />)
        const input = screen.getByTestId('chat-input')
        expect(input).toHaveAttribute(
          'placeholder',
          'common:voiceInput.startingPlaceholder'
        )

        act(() =>
          useVoiceInput.setState({ phase: 'listening', sessionId: 'session-1' })
        )
        expect(input).toHaveAttribute(
          'placeholder',
          'common:voiceInput.placeholder'
        )
        unmount()
      } finally {
        voice.restore()
      }
    })

    it('stops the start when the composer goes away', () => {
      // Left running, the start opened the microphone once the model was up,
      // for a composer that no longer existed.
      const voice = startVoiceHere()
      try {
        const { unmount } = render(<ChatInput />)
        expect(voice.cancel).not.toHaveBeenCalled()
        unmount()
        expect(voice.cancel).toHaveBeenCalledTimes(1)
        const after = useVoiceInput.getState()
        expect(after.phase).toBe('idle')
        expect(after.ownerKey).toBeNull()
        expect(after.lastOutcome).toBe('cancelled')
      } finally {
        voice.restore()
      }
    })
  })

  it('shows Send once there is text, and Stop while a reply streams', async () => {
    const { rerender, unmount } = render(<ChatInput />)
    const input = screen.getByTestId('chat-input')

    expect(screen.queryByTestId('send-control')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'Hello' } })
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).toBeEnabled()

    // Whitespace is not a message: the control leaves again.
    fireEvent.change(input, { target: { value: '   ' } })
    await waitFor(() =>
      expect(screen.queryByTestId('send-control')).not.toBeInTheDocument()
    )

    // A streaming reply keeps Stop in that corner with an empty field.
    rerender(<ChatInput chatStatus="streaming" />)
    const control = screen.getByTestId('send-control')
    expect(
      within(control).getByRole('button').getAttribute('data-variant')
    ).toBe('destructive')
    unmount()
  })

  it('names the icon-only Send and Stop buttons for assistive tech', () => {
    const { rerender, unmount } = render(<ChatInput />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Hello' },
    })
    expect(
      within(screen.getByTestId('send-control')).getByRole('button', {
        name: 'chat:sendMessage',
      })
    ).toBeEnabled()

    rerender(<ChatInput chatStatus="streaming" />)
    expect(
      within(screen.getByTestId('send-control')).getByRole('button', {
        name: 'common:stop',
      })
    ).toBeInTheDocument()
    unmount()
  })

  it('puts the model and the microphone beside Send', () => {
    const { unmount } = render(<ChatInput />)
    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Hello' },
    })

    const model = document.querySelector(
      '[data-test-id="model-picker-trigger"]'
    )
    const mic = document.querySelector('[data-test-id="voice-input-toggle"]')
    // Send sits in its reveal wrapper, which is the cluster's member.
    const send = screen.getByTestId('send-control')
    expect(model).toBeInTheDocument()
    expect(mic).toBeInTheDocument()
    expect(
      send.querySelector('[data-test-id="send-message-button"]')
    ).toBeInTheDocument()

    // One cluster on the right, the pill in a slot of its own that the
    // composer measures it by...
    const slot = model!.parentElement!
    expect(slot.childElementCount).toBe(1)
    expect(slot.parentElement).toBe(send.parentElement)
    expect(mic!.parentElement).toBe(send.parentElement)
    // ...reading [model] [mic] [send], with nothing ahead of the pill: the
    // reasoning bulb is gone, thinking is switched off on the effort slider.
    expect(send.parentElement!.firstElementChild).toBe(slot)
    expect(
      model!.compareDocumentPosition(mic!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      mic!.compareDocumentPosition(send!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    unmount()
  })

  it('submits entered text and clears the controlled prompt', async () => {
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)
    const input = screen.getByTestId('chat-input')

    fireEvent.change(input, { target: { value: 'Invoke the machine spirit' } })

    // Send only exists once there is text to send.
    const sendButton = document.querySelector(
      '[data-test-id="send-message-button"]'
    )
    expect(input).toHaveValue('Invoke the machine spirit')
    expect(sendButton).toBeEnabled()
    fireEvent.click(sendButton!)

    expect(onSubmit).toHaveBeenCalledWith(
      'Invoke the machine spirit',
      undefined,
      undefined
    )
    await waitFor(() => expect(input).toHaveValue(''))
    // The field is empty again, so Send leaves with it.
    await waitFor(() =>
      expect(screen.queryByTestId('send-control')).not.toBeInTheDocument()
    )
    unmount()
  })

  it('keeps an unsent draft with its own composer instead of every chat', () => {
    const previousThreadId = useThreads.getState().currentThreadId
    try {
      // A draft typed in a project composer and left unsent...
      act(() => useThreads.setState({ currentThreadId: undefined }))
      const project = render(<ChatInput initialMessage projectId="project-1" />)
      fireEvent.change(screen.getByTestId('chat-input'), {
        target: { value: 'Unsent project question' },
      })
      project.unmount()

      // ...stays out of two unrelated chats, which keep their own drafts,
      // also when one composer stays mounted while the chat changes.
      act(() => useThreads.setState({ currentThreadId: 'thread-a' }))
      const chat = render(<ChatInput />)
      const input = screen.getByTestId('chat-input')
      expect(input).toHaveValue('')
      fireEvent.change(input, { target: { value: 'Reply for A' } })
      act(() => useThreads.setState({ currentThreadId: 'thread-b' }))
      expect(input).toHaveValue('')
      act(() => useThreads.setState({ currentThreadId: 'thread-a' }))
      expect(input).toHaveValue('Reply for A')
      chat.unmount()

      // ...and is there again when the project is opened again.
      act(() => useThreads.setState({ currentThreadId: undefined }))
      const back = render(<ChatInput initialMessage projectId="project-1" />)
      expect(screen.getByTestId('chat-input')).toHaveValue(
        'Unsent project question'
      )
      back.unmount()
    } finally {
      useThreads.setState({ currentThreadId: previousThreadId })
      usePrompt.setState({ prompt: '', draftKey: null, drafts: {} })
    }
  })

  // The thread page sets `currentThreadId` in its own effect, after the
  // composer has committed. These read the textarea in a layout effect of a
  // later sibling: the composer's first commit, before any re-render.
  const firstCommits: string[] = []
  function FirstCommit({ threadId }: { threadId: string }) {
    useLayoutEffect(() => {
      const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
      firstCommits.push(`${threadId}: ${input.value}`)
    }, [threadId])
    return null
  }
  const threadPage = (threadId: string) => (
    <>
      <ChatInput threadId={threadId} />
      <FirstCommit threadId={threadId} />
    </>
  )

  it("commits the next chat's own draft on T1 → T2, not T1's", () => {
    const previousThreadId = useThreads.getState().currentThreadId
    firstCommits.length = 0
    try {
      act(() => useThreads.setState({ currentThreadId: 'thread-1' }))
      const view = render(threadPage('thread-1'))
      fireEvent.change(screen.getByTestId('chat-input'), {
        target: { value: 'Reply for T1' },
      })

      // T2's route renders while the global current thread is still T1.
      view.rerender(threadPage('thread-2'))
      expect(firstCommits.at(-1)).toBe('thread-2: ')
      fireEvent.change(screen.getByTestId('chat-input'), {
        target: { value: 'Reply for T2' },
      })
      act(() => useThreads.setState({ currentThreadId: 'thread-2' }))

      // And back: T1's draft is there on the first commit, T2's is kept.
      view.rerender(threadPage('thread-1'))
      expect(firstCommits.at(-1)).toBe('thread-1: Reply for T1')
      expect(usePrompt.getState().getDraft('thread-2')).toBe('Reply for T2')
      view.unmount()
    } finally {
      useThreads.setState({ currentThreadId: previousThreadId })
      usePrompt.setState({ prompt: '', draftKey: null, drafts: {} })
    }
  })

  it("opens a chat from Home with that chat's draft, and typing there leaves Home's alone", () => {
    const previousThreadId = useThreads.getState().currentThreadId
    firstCommits.length = 0
    try {
      act(() => useThreads.setState({ currentThreadId: undefined }))
      const home = render(<ChatInput initialMessage />)
      fireEvent.change(screen.getByTestId('chat-input'), {
        target: { value: 'Home draft' },
      })
      home.unmount()

      // Home cleared the current thread; the page sets it only later.
      const chat = render(threadPage('thread-1'))
      expect(firstCommits.at(-1)).toBe('thread-1: ')
      fireEvent.change(screen.getByTestId('chat-input'), {
        target: { value: 'Typed before the page caught up' },
      })
      expect(usePrompt.getState().getDraft('thread-1')).toBe(
        'Typed before the page caught up'
      )
      expect(usePrompt.getState().getDraft(TEMPORARY_CHAT_ID)).toBe(
        'Home draft'
      )
      chat.unmount()
    } finally {
      useThreads.setState({ currentThreadId: previousThreadId })
      usePrompt.setState({ prompt: '', draftKey: null, drafts: {} })
    }
  })

  it('keeps a slash-selected skill inline at the caret and sends that text with metadata', async () => {
    mocks.agentSkills = [
      {
        name: 'pdf',
        description: 'Create PDF documents',
        version: '1.0.0',
        requiresTools: [],
        requiresScripts: [],
        dangerous: false,
        platforms: null,
        enabled: true,
        compatible: true,
        reserved: true,
        unavailableReasons: [],
        error: null,
      },
    ]
    const onSubmit = vi.fn()
    render(<ChatInput onSubmit={onSubmit} />)
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement

    fireEvent.change(input, {
      target: { value: 'prefix /pd suffix', selectionStart: 10 },
    })
    fireEvent.click(screen.getByRole('option', { name: 'pdf' }))

    expect(input).toHaveValue('prefix /pdf suffix')
    expect(input.selectionStart).toBe(11)
    expect(screen.queryByTestId('agent-skill-inline-token')).toBeNull()

    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )

    expect(onSubmit).toHaveBeenCalledWith(
      'prefix /pdf suffix',
      undefined,
      'pdf'
    )
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('opens the reply-model widget instead of sending when none is selected', async () => {
    // With model preloading off by default, this is the state of every cold
    // launch until the user picks a model in the selector.
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)
    const input = screen.getByTestId('chat-input')

    fireEvent.change(input, { target: { value: 'Invoke the machine spirit' } })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )

    expect(await screen.findByTestId('reply-model-gate')).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
    // The typed prompt survives so it can go out once a model is ready.
    expect(input).toHaveValue('Invoke the machine spirit')
    unmount()
  })

  it('sends the held message by itself once a model can answer', async () => {
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)
    const input = screen.getByTestId('chat-input')

    fireEvent.change(input, { target: { value: 'Invoke the machine spirit' } })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )
    await screen.findByTestId('reply-model-gate')

    // The widget resolved: something is on its way, but not up yet.
    act(() => {
      mocks.replyGateProps!.onResolved({
        outcome: 'download',
        branch: 'none',
        decidedInMs: 5,
        openedAtMs: Date.now() - 5,
      })
    })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.queryByTestId('reply-gate-queued-notice')).toBeNull()

    // …and now it is. The message goes out unchanged, with nobody pressing
    // anything, and the widget gets out of the way.
    act(() => {
      useModelProvider.setState({
        selectedProvider: 'openai',
        selectedModel: {
          id: 'test-model',
          capabilities: [],
          settings: {},
        } as Model,
      })
    })

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Invoke the machine spirit',
        undefined,
        undefined
      )
    )
    expect(screen.queryByTestId('reply-model-gate')).toBeNull()
    unmount()
  })

  it('starts the downloaded first model and sends the preserved prompt when import completes', async () => {
    const modelId = 'LiquidAI/LFM2.5-2.6B-Q4_K_M'
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: '',
      selectedModel: null,
    })
    useAppState.setState({ activeModels: [], loadingModel: false })
    useDownloadStore.getState().addLocalDownloadingModel(modelId)
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Send this after the download' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )
    await screen.findByTestId('reply-model-gate')
    act(() => {
      mocks.replyGateProps!.onResolved({
        outcome: 'download_in_flight',
        branch: 'none',
        decidedInMs: 4,
        openedAtMs: Date.now() - 4,
        downloadModelIds: [modelId],
      })
    })

    // DataProvider refreshes the library after import but intentionally does
    // not auto-start arbitrary downloads. This queued Send supplies the intent.
    act(() => {
      useDownloadStore.getState().removeLocalDownloadingModel(modelId)
      useModelProvider.setState({
        providers: [
          {
            provider: 'llamacpp-upstream',
            active: true,
            models: [{ id: modelId, capabilities: [], settings: {} } as Model],
            settings: [],
          } as ModelProvider,
        ],
      })
    })

    await waitFor(() =>
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({
          providerName: 'llamacpp-upstream',
          modelId,
        })
      )
    )
    expect(onSubmit).not.toHaveBeenCalled()
    // The imported model is now the composer's selection, and the draft waits
    // in the field while it loads instead of going out to nothing.
    expect(useModelProvider.getState().selectedProvider).toBe(
      'llamacpp-upstream'
    )
    expect(useModelProvider.getState().selectedModel?.id).toBe(modelId)
    expect(screen.getByTestId('chat-input')).toHaveValue(
      'Send this after the download'
    )

    act(() => useAppState.setState({ activeModels: [modelId] }))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Send this after the download',
        undefined,
        undefined
      )
    )
    // The queued send is spent: the widget is gone and the field is clear.
    expect(screen.queryByTestId('reply-model-gate')).toBeNull()
    expect(screen.getByTestId('chat-input')).toHaveValue('')
    unmount()
  })

  it('hands a home-screen first download to the root queue', async () => {
    const modelId = 'LiquidAI/LFM2.5-2.6B-Q4_K_M'
    useModelProvider.setState({
      providers: [],
      selectedProvider: '',
      selectedModel: null,
    })
    const { unmount } = render(<ChatInput initialMessage />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Keep working even if I leave this screen' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )
    await screen.findByTestId('reply-model-gate')

    act(() => {
      mocks.replyGateProps!.onResolved({
        outcome: 'download_in_flight',
        branch: 'none',
        decidedInMs: 1,
        openedAtMs: Date.now() - 1,
        downloadModelIds: [modelId],
      })
    })

    expect(useDeferredFirstSend.getState().queued).toMatchObject({
      prompt: 'Keep working even if I leave this screen',
      downloadModelIds: [modelId],
    })
    // New Chat sends it itself while mounted, so the root stands down for it…
    const queueId = useDeferredFirstSend.getState().queued!.id
    expect(useDeferredFirstSend.getState().claimedId).toBe(queueId)
    expect(screen.getByTestId('chat-input')).toHaveValue(
      'Keep working even if I leave this screen'
    )
    unmount()
    // …and hands it back on leaving, still queued.
    expect(useDeferredFirstSend.getState().claimedId).toBeNull()
    expect(useDeferredFirstSend.getState().queued?.id).toBe(queueId)
  })

  it('queues the approval mode and workspace New Chat showed at Send with the message', async () => {
    const agent = useAgentMode.getState() as unknown as {
      approvalModes: Record<string, string>
      workspaces: Record<string, unknown>
    }
    const workspace = { externalRoots: [{ rootId: 'r1', path: '/w' }] }
    agent.approvalModes[TEMPORARY_CHAT_ID] = 'skip'
    agent.workspaces[TEMPORARY_CHAT_ID] = workspace
    try {
      useModelProvider.setState({
        providers: [],
        selectedProvider: '',
        selectedModel: null,
      })
      const { unmount } = render(<ChatInput initialMessage />)
      fireEvent.change(screen.getByTestId('chat-input'), {
        target: { value: 'Run it with full access' },
      })
      fireEvent.click(
        document.querySelector('[data-test-id="send-message-button"]')!
      )
      await screen.findByTestId('reply-model-gate')
      act(() => {
        mocks.replyGateProps!.onResolved({
          outcome: 'download_in_flight',
          branch: 'none',
          decidedInMs: 1,
          openedAtMs: Date.now() - 1,
          downloadModelIds: ['owner/model'],
        })
      })

      expect(useDeferredFirstSend.getState().queued?.agentState).toEqual({
        approvalMode: 'skip',
        workspace,
      })
      unmount()
    } finally {
      delete agent.approvalModes[TEMPORARY_CHAT_ID]
      delete agent.workspaces[TEMPORARY_CHAT_ID]
    }
  })

  it('drops the held message when the widget is dismissed', async () => {
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )
    await screen.findByTestId('reply-model-gate')

    act(() => {
      mocks.replyGateProps!.onDismissed({
        outcome: 'dismissed',
        branch: 'none',
        decidedInMs: 5,
        openedAtMs: Date.now() - 5,
      })
    })
    act(() => {
      useModelProvider.setState({
        selectedProvider: 'openai',
        selectedModel: {
          id: 'test-model',
          capabilities: [],
          settings: {},
        } as Model,
      })
    })

    // Giving up is not a deferred send: nothing goes out behind the user's
    // back, and the text they typed is still theirs to edit.
    await waitFor(() =>
      expect(screen.queryByTestId('reply-model-gate')).toBeNull()
    )
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('chat-input')).toHaveValue(
      'Invoke the machine spirit'
    )
    unmount()
  })

  it('answers with a connected cloud provider itself, without the widget', async () => {
    // The device already knows what to reply with; asking would be a
    // question with one answer (ATO-461).
    const model = { id: 'gpt-a', capabilities: [], settings: {} } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'openai',
          active: true,
          api_key: 'sk-test',
          models: [model],
          settings: [
            {
              key: 'api-key',
              title: 'API key',
              description: '',
              controller_type: 'input',
              controller_props: { value: 'sk-test' },
            },
          ],
        } as ModelProvider,
      ],
      selectedProvider: '',
      selectedModel: null,
    })
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )

    expect(screen.queryByTestId('reply-model-gate')).toBeNull()
    expect(mocks.switchToModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: 'openai', modelId: 'gpt-a' })
    )
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Invoke the machine spirit',
        undefined,
        undefined
      )
    )
    unmount()
  })

  it('starts the only local model on send and holds the message until it is up', async () => {
    const model = {
      id: 'Qwen3.5-4B-Q4_K_M',
      capabilities: [],
      settings: {},
    } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: '',
      selectedModel: null,
    })
    useAppState.setState({ activeModels: [] })
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )

    // No modal and no extra line under the composer: the queued send remains
    // internal until the selected model is ready.
    expect(screen.queryByTestId('reply-model-gate')).toBeNull()
    expect(screen.queryByTestId('reply-gate-queued-notice')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(useModelProvider.getState().selectedModel?.id).toBe(model.id)

    // The engine reports it up; the message goes out by itself.
    act(() => {
      useAppState.setState({ activeModels: [model.id] })
    })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Invoke the machine spirit',
        undefined,
        undefined
      )
    )
    unmount()
  })

  it('brings a model the user stopped back up on send, instead of blocking Send', async () => {
    const model = {
      id: 'Qwen3.5-4B-Q4_K_M',
      capabilities: [],
      settings: {},
    } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: 'llamacpp-upstream',
      selectedModel: model,
    })
    useAppState.setState({
      activeModels: [],
      loadingModel: false,
      userStoppedModels: [modelStopKey('llamacpp-upstream', model.id)],
    })
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    const send = document.querySelector('[data-test-id="send-message-button"]')!
    // Nothing else is going to start a model the user stopped, so waiting for
    // it to come up would leave Send dead for good.
    expect(send).not.toBeDisabled()
    fireEvent.click(send)

    await waitFor(() =>
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: model.id,
          providerName: 'llamacpp-upstream',
        })
      )
    )
    // An explicit start, like a pick in the dropdown — not a silent auto-start.
    expect(mocks.switchToModel.mock.calls[0][0].isAutoStart).toBeUndefined()
    expect(screen.queryByTestId('reply-gate-queued-notice')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()

    act(() => {
      useAppState.setState({ activeModels: [model.id], userStoppedModels: [] })
    })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Invoke the machine spirit',
        undefined,
        undefined
      )
    )
    unmount()
  })

  // ATO-530: a Cancel on the load a send is waiting for holds the model down,
  // so the send would wait forever. The text stays in the field.
  it('drops a waiting send when the user cancels the load it waits for', async () => {
    const model = {
      id: 'Qwen3.5-4B-Q4_K_M',
      capabilities: [],
      settings: {},
    } as Model
    const stopKey = modelStopKey('llamacpp-upstream', model.id)
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: 'llamacpp-upstream',
      selectedModel: model,
    })
    useAppState.setState({
      activeModels: [],
      loadingModel: false,
      userStoppedModels: [stopKey],
    })
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)
    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )
    await waitFor(() => expect(mocks.switchToModel).toHaveBeenCalled())
    expect(screen.queryByTestId('reply-gate-queued-notice')).toBeNull()

    // The real switch lifts the stop as the load starts; the Cancel sets it
    // again once the load is gone.
    act(() =>
      useAppState.setState({ userStoppedModels: [], loadingModel: true })
    )
    act(() =>
      useAppState.setState({
        userStoppedModels: [stopKey],
        loadingModel: false,
      })
    )

    await waitFor(() =>
      expect(
        screen.queryByTestId('reply-gate-queued-notice')
      ).not.toBeInTheDocument()
    )
    expect(onSubmit).not.toHaveBeenCalled()
    unmount()
  })

  it('drops a waiting send when the load it waits for fails', async () => {
    const model = {
      id: 'Qwen3.5-4B-Q4_K_M',
      capabilities: [],
      settings: {},
    } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: '',
      selectedModel: null,
    })
    useAppState.setState({
      activeModels: [],
      loadingModel: false,
      userStoppedModels: [],
    })
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)
    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )
    await waitFor(() => expect(mocks.switchToModel).toHaveBeenCalled())

    // The failure as `switchToModel` leaves it, in one step: the error is
    // recorded and the selection is gone.
    act(() => {
      useModelLoad
        .getState()
        .setModelLoadError('unsupported architecture', model.id)
      useModelProvider.getState().selectModelProvider('', '')
    })
    // A model picked and loaded later must not carry the old message out.
    act(() => {
      useModelProvider
        .getState()
        .selectModelProvider('llamacpp-upstream', model.id)
      useModelLoad.getState().setModelLoadError(undefined)
      useAppState.setState({ activeModels: [model.id] })
    })

    await act(async () => {})
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('chat-input')).toHaveValue(
      'Invoke the machine spirit'
    )
    unmount()
  })

  it('sends once a model that failed before comes up on the next Send', async () => {
    const model = {
      id: 'Qwen3.5-4B-Q4_K_M',
      capabilities: [],
      settings: {},
    } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: '',
      selectedModel: null,
    })
    // The previous load failed and cleared the selection; its error stays
    // recorded until a load succeeds.
    useModelLoad.getState().setModelLoadError('unsupported architecture', model.id)
    useAppState.setState({
      activeModels: [],
      loadingModel: false,
      userStoppedModels: [],
    })
    mocks.switchToModel.mockResolvedValue(undefined)
    const onSubmit = vi.fn()
    const { unmount } = render(<ChatInput onSubmit={onSubmit} />)
    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })
    fireEvent.click(
      document.querySelector('[data-test-id="send-message-button"]')!
    )
    await waitFor(() => expect(mocks.switchToModel).toHaveBeenCalled())
    expect(useModelProvider.getState().selectedModel?.id).toBe(model.id)

    act(() => useAppState.setState({ loadingModel: true }))
    act(() => {
      useModelLoad.getState().setModelLoadError(undefined)
      useAppState.setState({ activeModels: [model.id], loadingModel: false })
    })
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        'Invoke the machine spirit',
        undefined,
        undefined
      )
    )
    unmount()
  })

  it('marks Send as needing a model before it is pressed', () => {
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })
    const { unmount } = render(<ChatInput onSubmit={vi.fn()} />)

    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Invoke the machine spirit' },
    })

    // The state is on the button itself, so the user learns about it without
    // pressing — the red line only ever appeared afterwards.
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).toHaveAttribute('data-needs-model', 'true')
    unmount()
  })

  // Agent affordances need the global toggle on AND an agent-capable
  // provider: the seeded 'openai' provider has no API key, which would still
  // route to the chat fallback.
  const selectLocalProvider = () => {
    useGeneralSetting.setState({ agentModeEnabled: true })
    const model = { id: 'local-model', capabilities: [], settings: {} } as Model
    const provider = {
      provider: 'llamacpp',
      active: true,
      models: [model],
      settings: [],
    } as ModelProvider
    useModelProvider.setState({
      providers: [provider],
      selectedProvider: 'llamacpp',
      selectedModel: model,
    })
  }

  it('keeps the agent affordances on the project composer but hides Add folder', () => {
    selectLocalProvider()
    const { unmount } = render(
      <ChatInput initialMessage projectId="project-1" />
    )

    // The agent chip proves the project composer routes to the agent engine
    // (the old project gate is gone)...
    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).toBeInTheDocument()
    // ...while the workspace-folder button stays off this page: it has no
    // files panel to surface the folder in.
    expect(
      screen.queryByRole('button', { name: 'chat:agentWorkspace.addFolder' })
    ).not.toBeInTheDocument()
    unmount()
  })

  it('lets the project composer fill its card column and start taller', () => {
    const { unmount } = render(
      <ChatInput
        initialMessage
        projectId="project-1"
        containerClassName="max-w-none"
        minRows={4}
      />
    )

    expect(document.querySelector('[data-composer-anchor]')).toHaveClass(
      'max-w-none'
    )
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'data-min-rows',
      '4'
    )
    unmount()
  })

  it('offers Add folder beside the paperclip of a plain composer', () => {
    selectLocalProvider()
    const { unmount } = render(<ChatInput initialMessage />)

    const addFolder = screen.getByRole('button', {
      name: 'chat:agentWorkspace.addFolder',
    })
    expect(
      screen
        .getByTestId('composer-attach')
        .compareDocumentPosition(addFolder) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    unmount()
  })

  it('keeps the connectors and web search controls before a model is picked', () => {
    // A composer stripped down to a plus button reads as broken; the real
    // `tools` capability only starts gating once a model is actually selected.
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: false },
      },
    })
    useModelProvider.setState({ selectedProvider: '', selectedModel: null })

    const { unmount } = render(<ChatInput />)

    expect(
      document.querySelector('[data-test-id="connectors-dropdown"]')
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText('common:webSearchToggleDisabled')
    ).toBeInTheDocument()

    useMCPServers.setState({ mcpServers: {} })
    unmount()
  })

  // A model that actually advertises tools: the connectors button and the
  // attach-menu pin toggle both hang off that capability.
  const selectToolCapableModel = () => {
    const model = {
      id: 'tool-model',
      capabilities: ['tools'],
      settings: {},
    } as unknown as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'openai',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: 'openai',
      selectedModel: model,
    })
  }

  it('keeps the Plugins button in the toolbar next to web search, with no setting behind it', () => {
    // Same standing as the globe: always on the toolbar, and each
    // connector's on/off switch lives inside its dropdown. No store flag is
    // left that could hide it.
    useMCPServers.setState({
      mcpServers: {
        exa: { command: '', args: [], env: {}, active: true },
      },
    })
    selectToolCapableModel()

    const { unmount } = render(<ChatInput />)

    const plugins = screen.getByRole('button', { name: 'plugins' })
    expect(
      plugins.querySelector('[data-test-id="connectors-dropdown"]')
    ).toBeInTheDocument()
    const globe = screen.getByLabelText(
      /common:webSearchToggle(?:Enabled|Unavailable)/
    )
    expect(plugins.parentElement).toBe(globe.parentElement)
    expect(
      plugins.compareDocumentPosition(globe) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect('connectorsPinned' in useGeneralSetting.getState()).toBe(false)

    useMCPServers.setState({ mcpServers: {} })
    unmount()
  })

  it('attaches through one paperclip, with no menu and no Plugins item', () => {
    // Plugins is a toolbar fixture of its own; the paperclip is a plain
    // button that opens the picker, and Agent mode moved to the access menu.
    selectToolCapableModel()

    const { unmount } = render(<ChatInput />)

    const attach = screen.getByRole('button', {
      name: 'chat:composer.attachFiles',
    })
    expect(attach).toHaveAttribute('data-testid', 'composer-attach')
    expect(attach).not.toHaveAttribute('aria-haspopup')
    expect(screen.queryByText('Add Images')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Add documents or files')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('plugins')).not.toBeInTheDocument()

    unmount()
  })

  // The paperclip's picker hands its paths to the drop path: one native
  // dialog for every supported type, then the same per-type rules.
  const seedPicker = (paths: string[] | null) => {
    const open = vi.fn().mockResolvedValue(paths)
    seedServiceHub({
      dialog: { open, save: vi.fn() } as unknown as ReturnType<
        ServiceHub['dialog']
      >,
    })
    return open
  }

  it('offers every supported type in one picker and routes the pick like a drop', async () => {
    const open = seedPicker([
      '/Users/me/notes.pdf',
      '/Users/me/photo.png',
      '/Users/me/clip.mp3',
      '/Users/me/setup.exe',
    ])
    useThreads.setState({ currentThreadId: undefined })
    const { unmount } = render(<ChatInput />)

    fireEvent.click(screen.getByTestId('composer-attach'))

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const options = open.mock.calls[0][0]
    expect(options.multiple).toBe(true)
    expect(options.filters).toHaveLength(1)
    expect(options.filters[0].name).toBe('chat:composer.supportedFiles')
    expect(options.filters[0].extensions).toEqual(
      expect.arrayContaining(['png', 'jpg', 'webp', 'mp3', 'wav', 'pdf', 'md'])
    )

    // Documents go to the thread's attachments (retrieval decides later).
    await waitFor(() =>
      expect(useChatAttachments.getState().getAttachments()).toEqual([
        expect.objectContaining({
          type: 'document',
          name: 'notes.pdf',
          path: '/Users/me/notes.pdf',
        }),
      ])
    )
    // The model cannot see images: offer a vision model, as "Add Images" did.
    expect(screen.getByTestId('vision-model-dialog')).toBeInTheDocument()
    // Nor hear audio; and an unknown type is named, not dropped silently.
    expect(toast.error).toHaveBeenCalledWith(
      'Audio model required',
      expect.anything()
    )
    expect(toast.warning).toHaveBeenCalledWith(
      'Unsupported file type',
      expect.objectContaining({
        description: expect.stringContaining('setup.exe'),
      })
    )
    unmount()
  })

  it('opens no picker while attachments are off in Settings', async () => {
    const open = seedPicker(['/Users/me/notes.pdf'])
    useAttachments.setState({ enabled: false })
    const { unmount } = render(<ChatInput />)

    fireEvent.click(screen.getByTestId('composer-attach'))

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        'Attachments are disabled in Settings'
      )
    )
    expect(open).not.toHaveBeenCalled()
    // Nothing reaches the thread's attachments either.
    expect(useChatAttachments.getState().getAttachments()).toEqual([])
    unmount()
  })

  it('says so when the picker fails to open', async () => {
    const open = vi.fn().mockRejectedValue(new Error('no portal'))
    seedServiceHub({
      dialog: { open, save: vi.fn() } as unknown as ReturnType<
        ServiceHub['dialog']
      >,
    })
    const { unmount } = render(<ChatInput />)

    fireEvent.click(screen.getByTestId('composer-attach'))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('chat:composer.attachFailed', {
        description: 'no portal',
      })
    )
    // The failed picker attaches nothing, and the composer stays usable.
    expect(useChatAttachments.getState().getAttachments()).toEqual([])
    expect(screen.getByTestId('composer-attach')).toBeEnabled()
    unmount()
  })

  it('falls back to the file input on the web build', () => {
    platform.tauri = false
    const open = seedPicker(['/Users/me/notes.pdf'])
    const { unmount } = render(<ChatInput />)
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"]'
    )!
    const click = vi.spyOn(input, 'click')

    fireEvent.click(screen.getByTestId('composer-attach'))

    expect(click).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
    expect(input.accept).toContain('.pdf')
    expect(input.accept).toContain('.png')
    unmount()
  })

  it('keeps the agent controls while no provider is resolved yet, if agent mode is on', () => {
    // The provider list loads asynchronously at boot and no model is picked on
    // a cold launch: routing says "chat transport" only because it has nothing
    // to judge, and a composer the user switched to Agent mode must not shed
    // its agent controls meanwhile.
    useGeneralSetting.setState({ agentModeEnabled: true })
    useModelProvider.setState({
      providers: [],
      selectedProvider: '',
      selectedModel: null,
    })

    const { unmount } = render(<ChatInput initialMessage />)

    expect(
      document.querySelector('[data-test-id="approval-mode-select"]')
    ).toBeInTheDocument()
    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'chat:agentWorkspace.addFolder' })
    ).toBeInTheDocument()
    unmount()
  })

  it('shows the plain chat composer by default even on an agent-capable provider', () => {
    // Chat is the default engine: with the global toggle off, an agent-capable
    // local provider still gets the chat placeholder and no agent controls.
    const model = { id: 'local-model', capabilities: [], settings: {} } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: 'llamacpp',
      selectedModel: model,
    })

    const { unmount } = render(<ChatInput initialMessage />)

    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'placeholder',
      'common:placeholder.chatInput'
    )
    // The approval select stays in the toolbar for both engines — it governs
    // chat MCP/RAG calls too — but the agent chip only shows with the toggle.
    expect(
      document.querySelector('[data-test-id="approval-mode-select"]')
    ).toBeInTheDocument()
    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).not.toBeInTheDocument()
    unmount()
  })

  it('toggles the global agent mode from the access menu', () => {
    const { unmount } = render(<ChatInput />)

    fireEvent.click(screen.getByText('chat:agentMode.menuItem'))
    expect(useGeneralSetting.getState().agentModeEnabled).toBe(true)

    fireEvent.click(screen.getByText('chat:agentMode.menuItem'))
    expect(useGeneralSetting.getState().agentModeEnabled).toBe(false)
    unmount()
  })

  it('hides Agent mode while the feature is off, even with the stored toggle on', () => {
    // An install that had Agent mode on keeps the persisted flag, but nothing
    // offers or shows the mode while it is hidden.
    platformFeatures.agentMode = false
    useGeneralSetting.setState({ agentModeEnabled: true })
    selectLocalProvider()

    const { unmount } = render(<ChatInput initialMessage />)

    expect(
      screen.queryByText('chat:agentMode.menuItem')
    ).not.toBeInTheDocument()
    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).not.toBeInTheDocument()
    expect(useGeneralSetting.getState().agentModeEnabled).toBe(true)
    unmount()
  })

  it('puts no Run commands switch in the access menu: commands are always on', () => {
    // The platform can run commands, yet the menu's only switch is Agent mode.
    const { unmount } = render(<ChatInput />)

    const menu = document.querySelector<HTMLElement>(
      '[data-test-id="approval-mode-select"]'
    )!
    expect(
      within(menu)
        .getAllByRole('button')
        .map((toggle) => toggle.textContent)
    ).toEqual(['chat:agentMode.menuItem'])
    unmount()
  })

  it('says in the access menu when global auto-approve overrides Restricted, linking to that setting', () => {
    const allowAll = useToolApproval.getState().allowAllMCPPermissions
    try {
      // No mode picked on this composer, so it shows Restricted, while the
      // global switch runs connector tools such as web search unasked.
      useToolApproval.setState({ allowAllMCPPermissions: true })
      const { unmount } = render(<ChatInput />)

      const note = document.querySelector<HTMLElement>(
        '[data-test-id="approval-manual-override"]'
      )!
      expect(note).toHaveTextContent('chat:agentApprovals.autoApproveOverride')
      fireEvent.click(
        within(note).getByText('chat:agentApprovals.openAutoApproveSetting')
      )
      expect(mocks.navigate).toHaveBeenCalledWith({ to: '/settings/general' })

      // With the switch off, Restricted asks as it says: nothing to add.
      act(() => useToolApproval.setState({ allowAllMCPPermissions: false }))
      expect(
        document.querySelector('[data-test-id="approval-manual-override"]')
      ).not.toBeInTheDocument()
      unmount()
    } finally {
      useToolApproval.setState({ allowAllMCPPermissions: allowAll })
    }
  })

  it('renders the agent chip whose X turns the mode off everywhere', () => {
    selectLocalProvider()

    const { unmount } = render(<ChatInput initialMessage />)

    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('chat:agentMode.turnOff'))
    expect(useGeneralSetting.getState().agentModeEnabled).toBe(false)
    expect(
      document.querySelector('[data-testid="agent-mode-chip"]')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'placeholder',
      'common:placeholder.chatInput'
    )
    unmount()
  })

  it('reveals an image remove button only on hover or keyboard focus', () => {
    useThreads.setState({ currentThreadId: undefined })
    useChatAttachments.setState({
      attachmentsByThread: {
        '__new-thread__': [
          {
            type: 'image',
            name: 'reference.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,dGVzdA==',
            base64: 'dGVzdA==',
            size: 4,
          },
        ],
      },
    })

    render(<ChatInput />)

    const remove = screen.getByRole('button', {
      name: 'Remove reference.png',
    })
    expect(remove).toHaveClass(
      'bg-foreground',
      'text-background',
      'opacity-0',
      'group-hover/attachment:opacity-100',
      'focus-visible:opacity-100'
    )
    expect(remove).not.toHaveClass('bg-destructive')
  })

  it('downscales an image before applying the byte limit', async () => {
    const model = {
      id: 'vision-model',
      capabilities: ['vision'],
      settings: {},
    } as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'openai',
          active: true,
          models: [model],
          settings: [],
        } as ModelProvider,
      ],
      selectedProvider: 'openai',
      selectedModel: model,
    })
    mocks.downscaleImageDataUrl.mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,dGVzdA==',
      base64: 'dGVzdA==',
      mimeType: 'image/jpeg',
      size: 4,
    })

    render(<ChatInput />)
    const file = new File(['test'], 'camera.jpg', { type: 'image/jpeg' })
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 })

    fireEvent.paste(screen.getByTestId('chat-input'), {
      clipboardData: {
        items: [
          {
            type: 'image/jpeg',
            getAsFile: () => file,
          },
        ],
      },
    })

    await waitFor(() => {
      expect(useChatAttachments.getState().getAttachments()).toEqual([
        expect.objectContaining({
          name: 'camera.jpg',
          mimeType: 'image/jpeg',
          size: 4,
          base64: 'dGVzdA==',
        }),
      ])
    })
  })
})

describe('ChatInput local model auto-start', () => {
  const localModel = {
    id: 'shared-model',
    capabilities: [],
    settings: {},
  } as Model
  const upstream = {
    provider: 'llamacpp-upstream',
    active: true,
    models: [localModel],
    settings: [],
  } as ModelProvider

  function seedModels(activeByProvider: Record<string, string[]>) {
    const getActiveModels = vi.fn(async (provider?: string) =>
      provider
        ? (activeByProvider[provider] ?? [])
        : [...new Set(Object.values(activeByProvider).flat())]
    )
    const stopAllModelsExcept = vi.fn().mockResolvedValue(undefined)
    seedServiceHub({
      models: {
        getActiveModels,
        stopAllModelsExcept,
      } as unknown as ReturnType<ServiceHub['models']>,
    })
    return { getActiveModels, stopAllModelsExcept }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.chatBusy = false
    mocks.switchToModel.mockResolvedValue(undefined)
    usePrompt.setState({ prompt: '' })
    useChatAttachments.setState({ attachmentsByThread: {} })
    useGeneralSetting.setState({ agentModeEnabled: false })
    useModelProvider.setState({
      providers: [upstream],
      selectedProvider: 'llamacpp-upstream',
      selectedModel: localModel,
    })
  })

  it.each([false, true])(
    'does not load or start after Skip clears selection (installed model: %s)',
    async (installed) => {
      const startModel = vi.fn()
      seedServiceHub({
        models: {
          getActiveModels: vi.fn().mockResolvedValue([]),
          startModel,
        } as unknown as ReturnType<ServiceHub['models']>,
      })
      useModelProvider.setState({
        providers: installed ? [upstream] : [],
        selectedProvider: '',
        selectedModel: null,
      })
      useAppState.setState({
        activeModels: [],
        loadingModel: false,
        serverStatus: 'stopped',
      })
      const { unmount } = render(<ChatInput />)
      await act(async () => {})

      expect(screen.getByTestId('chat-input')).toBeVisible()
      expect(useModelProvider.getState().selectedModel).toBeNull()
      expect(useAppState.getState().activeModels).toEqual([])
      expect(useAppState.getState().serverStatus).toBe('stopped')
      expect(mocks.switchToModel).not.toHaveBeenCalled()
      expect(startModel).not.toHaveBeenCalled()
      unmount()
    }
  )

  it('drops a stray copy in another engine instead of switching', async () => {
    const { stopAllModelsExcept } = seedModels({
      'llamacpp-upstream': ['shared-model'],
      'llamacpp': ['shared-model'],
    })
    useAppState.setState({ activeModels: [] })
    const { unmount } = render(<ChatInput />)

    await waitFor(() => {
      expect(stopAllModelsExcept).toHaveBeenCalledWith(
        'shared-model',
        'llamacpp-upstream'
      )
    })
    expect(mocks.switchToModel).not.toHaveBeenCalled()
    // The serving engine keeps the model, so the composer shows it as running.
    await waitFor(() => {
      expect(useAppState.getState().activeModels).toEqual(['shared-model'])
    })
    unmount()
  })

  it('auto-starts when the selected engine does not serve the model', async () => {
    seedModels({})
    // A stale mark from an engine that is gone (e.g. a crashed backend).
    useAppState.setState({ activeModels: ['shared-model'] })
    const { unmount } = render(<ChatInput />)

    await waitFor(() => {
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'shared-model',
          providerName: 'llamacpp-upstream',
          isAutoStart: true,
        })
      )
    })
    // Until the start lands, the composer no longer claims the model runs.
    expect(useAppState.getState().activeModels).toEqual([])
    unmount()
  })

  it('never touches the engines while this thread is streaming', async () => {
    const { getActiveModels, stopAllModelsExcept } = seedModels({
      'llamacpp-upstream': ['shared-model'],
      'llamacpp': ['shared-model'],
    })
    useAppState.setState({ activeModels: [] })
    const { unmount } = render(<ChatInput chatStatus="streaming" />)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getActiveModels).not.toHaveBeenCalled()
    expect(stopAllModelsExcept).not.toHaveBeenCalled()
    expect(mocks.switchToModel).not.toHaveBeenCalled()
    // No probe ran, so the engines' report never reached the app state.
    expect(useAppState.getState().activeModels).toEqual([])
    unmount()
  })

  it('never touches the engines while another chat is busy', async () => {
    mocks.chatBusy = true
    const { getActiveModels } = seedModels({})
    useAppState.setState({ activeModels: ['shared-model'] })
    const { unmount } = render(<ChatInput />)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(getActiveModels).not.toHaveBeenCalled()
    expect(mocks.switchToModel).not.toHaveBeenCalled()
    // The empty engine report was never synced over the running model.
    expect(useAppState.getState().activeModels).toEqual(['shared-model'])
    unmount()
  })
})
