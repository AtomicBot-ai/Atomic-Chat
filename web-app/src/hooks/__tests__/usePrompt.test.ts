import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  DRAFT_MAX_AGE_MS,
  DRAFT_MAX_COUNT,
  loadStoredDrafts,
  selectDraft,
  usePrompt,
} from '../usePrompt'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

describe('usePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    usePrompt.setState({ prompt: '', draftKey: null, drafts: {} })
  })

  it('should initialize with empty prompt', () => {
    const { result } = renderHook(() => usePrompt())
    
    expect(result.current.prompt).toBe('')
    expect(typeof result.current.setPrompt).toBe('function')
  })

  it('should update prompt', () => {
    const { result } = renderHook(() => usePrompt())
    
    act(() => {
      result.current.setPrompt('Hello, world!')
    })
    
    expect(result.current.prompt).toBe('Hello, world!')
  })

  it('should clear prompt', () => {
    const { result } = renderHook(() => usePrompt())
    
    act(() => {
      result.current.setPrompt('Some text')
    })
    
    expect(result.current.prompt).toBe('Some text')
    
    act(() => {
      result.current.setPrompt('')
    })
    
    expect(result.current.prompt).toBe('')
  })

  it('should handle multiple prompt updates', () => {
    const { result } = renderHook(() => usePrompt())
    
    act(() => {
      result.current.setPrompt('First')
    })
    
    expect(result.current.prompt).toBe('First')
    
    act(() => {
      result.current.setPrompt('Second')
    })
    
    expect(result.current.prompt).toBe('Second')
    
    act(() => {
      result.current.setPrompt('Third')
    })
    
    expect(result.current.prompt).toBe('Third')
  })

  it('should handle special characters in prompt', () => {
    const { result } = renderHook(() => usePrompt())
    
    const specialText = 'Hello! @#$%^&*()_+{}|:"<>?[]\\;\',./'
    
    act(() => {
      result.current.setPrompt(specialText)
    })
    
    expect(result.current.prompt).toBe(specialText)
  })

  it('should handle multiline prompts', () => {
    const { result } = renderHook(() => usePrompt())
    
    const multilineText = 'Line 1\nLine 2\nLine 3'
    
    act(() => {
      result.current.setPrompt(multilineText)
    })
    
    expect(result.current.prompt).toBe(multilineText)
  })

  it('should handle very long prompts', () => {
    const { result } = renderHook(() => usePrompt())
    
    const longText = 'A'.repeat(10000)
    
    act(() => {
      result.current.setPrompt(longText)
    })
    
    expect(result.current.prompt).toBe(longText)
    expect(result.current.prompt.length).toBe(10000)
  })

  it('keeps a draft when the composer remounts in the same app session', () => {
    const firstMount = renderHook(() => usePrompt((state) => state.prompt))

    act(() => {
      usePrompt.getState().setPrompt('Keep this while I change routes')
    })
    firstMount.unmount()

    const secondMount = renderHook(() => usePrompt((state) => state.prompt))
    expect(secondMount.result.current).toBe(
      'Keep this while I change routes'
    )
  })

  it('keeps a project draft out of unrelated chats and brings it back to the project', () => {
    const { bindDraft, setPrompt } = usePrompt.getState()
    act(() => {
      bindDraft('project:p1')
      setPrompt('Unsent project question')
    })

    act(() => bindDraft('thread-a'))
    expect(usePrompt.getState().prompt).toBe('')
    act(() => bindDraft('thread-b'))
    expect(usePrompt.getState().prompt).toBe('')

    act(() => bindDraft('project:p1'))
    expect(usePrompt.getState().prompt).toBe('Unsent project question')
  })

  it('gives each chat back its own draft when the user returns to it', () => {
    const { bindDraft, setPrompt } = usePrompt.getState()
    act(() => {
      bindDraft('thread-a')
      setPrompt('Reply for A')
      bindDraft('thread-b')
      setPrompt('Reply for B')
      bindDraft('thread-a')
    })
    expect(usePrompt.getState().prompt).toBe('Reply for A')

    act(() => bindDraft('thread-b'))
    expect(usePrompt.getState().prompt).toBe('Reply for B')
    // A cleared composer leaves nothing parked behind.
    act(() => {
      setPrompt('')
      bindDraft('thread-a')
    })
    expect(usePrompt.getState().drafts).toEqual({})
  })

  it('reads and writes a parked draft without disturbing the open composer', () => {
    const { bindDraft, setPrompt, getDraft, setDraft } = usePrompt.getState()
    act(() => {
      bindDraft('home')
      setPrompt('Queued on home')
      bindDraft('thread-a')
      setPrompt('Typing in A')
    })
    expect(getDraft('home')).toBe('Queued on home')
    expect(getDraft('thread-a')).toBe('Typing in A')

    act(() => setDraft('home', ''))
    expect(getDraft('home')).toBe('')
    expect(usePrompt.getState().prompt).toBe('Typing in A')

    act(() => bindDraft('home'))
    expect(usePrompt.getState().prompt).toBe('')
  })

  it('hands text typed before any composer bound to the first one that binds', () => {
    act(() => usePrompt.getState().setPrompt('Seeded'))
    act(() => usePrompt.getState().bindDraft('thread-a'))

    expect(usePrompt.getState().prompt).toBe('Seeded')
    expect(usePrompt.getState().draftKey).toBe('thread-a')
  })

  it('does not bring back text no composer owned, or the old single-prompt blob', async () => {
    usePrompt.getState().setPrompt('Old in-memory draft')
    localStorage.setItem(
      'prompt',
      JSON.stringify({ state: { prompt: 'Old local draft' }, version: 1 })
    )
    sessionStorage.setItem('prompt', 'Old session draft')

    vi.resetModules()
    const { usePrompt: freshSessionPrompt } = await import('../usePrompt')

    expect(freshSessionPrompt.getState().prompt).toBe('')
    expect(freshSessionPrompt.getState().drafts).toEqual({})
  })
})

/** The store a relaunched app starts with: a fresh module over the same localStorage. */
async function relaunch() {
  vi.resetModules()
  return (await import('../usePrompt')).usePrompt
}

describe('usePrompt across a relaunch (QA 2.2.25 NEW-03)', () => {
  beforeEach(() => {
    localStorage.clear()
    usePrompt.setState({ prompt: '', draftKey: null, drafts: {} })
  })

  it("brings a saved chat's unsent draft back after a quit and relaunch", async () => {
    act(() => {
      usePrompt.getState().bindDraft('thread-a')
      usePrompt.getState().setPrompt('DRAFT RESTART 274')
    })

    const relaunched = await relaunch()
    // The composer's first render already shows it, before it binds.
    expect(selectDraft('thread-a')(relaunched.getState())).toBe(
      'DRAFT RESTART 274'
    )
    act(() => relaunched.getState().bindDraft('thread-a'))
    expect(relaunched.getState().prompt).toBe('DRAFT RESTART 274')
  })

  it('keeps a restored project draft out of every other composer (AC-04)', async () => {
    act(() => {
      usePrompt.getState().bindDraft('project:p1')
      usePrompt.getState().setPrompt('DRAFT PROJECT ONLY 274')
    })

    const relaunched = await relaunch()
    expect(selectDraft('thread-a')(relaunched.getState())).toBe('')
    act(() => relaunched.getState().bindDraft('thread-a'))
    expect(relaunched.getState().prompt).toBe('')
    act(() => relaunched.getState().bindDraft(TEMPORARY_CHAT_ID))
    expect(relaunched.getState().prompt).toBe('')

    act(() => relaunched.getState().bindDraft('project:p1'))
    expect(relaunched.getState().prompt).toBe('DRAFT PROJECT ONLY 274')
  })

  it('forgets a draft once it is sent', async () => {
    act(() => {
      usePrompt.getState().bindDraft('thread-a')
      usePrompt.getState().setPrompt('About to send')
    })
    // ChatInput clears its draft by key when the message goes out.
    act(() => usePrompt.getState().setDraft('thread-a', ''))

    expect(localStorage.getItem('composer-draft:thread-a')).toBeNull()
    const relaunched = await relaunch()
    act(() => relaunched.getState().bindDraft('thread-a'))
    expect(relaunched.getState().prompt).toBe('')
  })

  it("does not keep the home composer's draft, which a temporary chat shares", async () => {
    act(() => {
      usePrompt.getState().bindDraft(TEMPORARY_CHAT_ID)
      usePrompt.getState().setPrompt('Typed in a temporary chat')
    })

    expect(
      localStorage.getItem(`composer-draft:${TEMPORARY_CHAT_ID}`)
    ).toBeNull()
    const relaunched = await relaunch()
    act(() => relaunched.getState().bindDraft(TEMPORARY_CHAT_ID))
    expect(relaunched.getState().prompt).toBe('')
  })

  it('never writes over a draft another chat window saved', () => {
    // This window parked a draft for thread-b, then a detached window for
    // thread-b changed it there.
    act(() => {
      usePrompt.getState().bindDraft('thread-b')
      usePrompt.getState().setPrompt('First words in B')
      usePrompt.getState().bindDraft('thread-a')
    })
    localStorage.setItem(
      'composer-draft:thread-b',
      JSON.stringify({ text: 'Rewritten in the B window', at: Date.now() })
    )

    act(() => usePrompt.getState().setPrompt('Typing in A'))
    expect(
      JSON.parse(localStorage.getItem('composer-draft:thread-b')!).text
    ).toBe('Rewritten in the B window')

    // Coming back to B shows the newest text, not the stale parked copy.
    act(() => usePrompt.getState().bindDraft('thread-b'))
    expect(usePrompt.getState().prompt).toBe('Rewritten in the B window')
  })

  it('keeps the text in memory when storage refuses the write', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError')
      })
    try {
      act(() => {
        usePrompt.getState().bindDraft('thread-a')
        usePrompt.getState().setPrompt('Too big to store')
        usePrompt.getState().bindDraft('thread-b')
        usePrompt.getState().bindDraft('thread-a')
      })
      expect(usePrompt.getState().prompt).toBe('Too big to store')
    } finally {
      setItem.mockRestore()
    }
  })

  it("drops a deleted chat's draft from memory and disk", () => {
    act(() => {
      usePrompt.getState().bindDraft('thread-a')
      usePrompt.getState().setPrompt('Draft in A')
      usePrompt.getState().bindDraft('thread-b')
      usePrompt.getState().setPrompt('Draft in B')
    })

    act(() => {
      usePrompt.getState().clearDraft('thread-a')
      usePrompt.getState().clearDraft('thread-b')
    })

    expect(usePrompt.getState().drafts).toEqual({})
    expect(usePrompt.getState().prompt).toBe('')
    expect(localStorage.getItem('composer-draft:thread-a')).toBeNull()
    expect(localStorage.getItem('composer-draft:thread-b')).toBeNull()
  })

  it('prunes old, surplus and unreadable drafts at launch', () => {
    const now = Date.UTC(2026, 9, 26)
    const store = (key: string, text: string, at: number) =>
      localStorage.setItem(
        `composer-draft:${key}`,
        JSON.stringify({ text, at })
      )
    store('stale', 'Untouched for too long', now - DRAFT_MAX_AGE_MS - 1)
    for (let index = 0; index < DRAFT_MAX_COUNT + 2; index++) {
      store(`thread-${index}`, `Draft ${index}`, now - index * 1000)
    }
    localStorage.setItem('composer-draft:broken', '{not json')
    localStorage.setItem('setting-general', 'untouched')

    const drafts = loadStoredDrafts(now)

    expect(Object.keys(drafts)).toHaveLength(DRAFT_MAX_COUNT)
    expect(drafts['thread-0']).toBe('Draft 0')
    expect(drafts[`thread-${DRAFT_MAX_COUNT - 1}`]).toBeDefined()
    expect(drafts[`thread-${DRAFT_MAX_COUNT}`]).toBeUndefined()
    expect(
      localStorage.getItem(`composer-draft:thread-${DRAFT_MAX_COUNT}`)
    ).toBeNull()
    expect(localStorage.getItem('composer-draft:stale')).toBeNull()
    expect(localStorage.getItem('composer-draft:broken')).toBeNull()
    expect(localStorage.getItem('setting-general')).toBe('untouched')
  })
})
