import { localStorageKey } from '@/constants/localStorage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * The three ways the backend a user sees can disagree with the one doing the
 * work. Mirrors `BackendMismatch` in both llama.cpp extensions' `util.ts` — the
 * web-app cannot import the extension bundle, so the shape is restated here.
 */
export type BackendMismatch =
  | { kind: 'silent-fallback'; configured: string; effective: string }
  | {
      kind: 'runtime-cpu'
      configured: string
      primaryDevice: string
      offloaded: number | null
      total: number | null
      /** GPU stack of the build that fell back, so the advice can match it. */
      gpuKind: 'cuda' | 'rocm' | 'vulkan' | 'other'
      cudaRuntimeMissing: boolean
      deviceInitError: string | null
    }
  | { kind: 'suboptimal-config'; configured: string; ideal: string }

/**
 * Window event that opens `SuboptimalBackendDialog`. Detection happens at model
 * load, but the prompt is raised on the first message send so a load is never
 * interrupted; `ChatInput` dispatches this without blocking the send.
 */
export const BACKEND_MISMATCH_PROMPT_EVENT = 'app:backend-mismatch-prompt'

/**
 * A mismatch worth telling the user about. `pending` only ever holds one of
 * these.
 */
export type BackendMismatchEvent = {
  provider: string
  modelId: string
  configuredVersionBackend: string
  effectiveVersionBackend: string
  mismatch: BackendMismatch
}

/**
 * Payload of `AppEvent.onBackendRuntimeReported`, emitted for every successful
 * load. `kind: 'ok'` means this provider is now running as configured, which is
 * what retires a warning the user has already fixed.
 */
export type BackendRuntimeEvent = Omit<BackendMismatchEvent, 'mismatch'> & {
  mismatch: BackendMismatch | { kind: 'ok' }
}

/**
 * Identifies a mismatch by what it is about rather than by which model exposed
 * it, so switching models does not re-raise a prompt the user already declined.
 */
export function mismatchPairKey(event: BackendMismatchEvent): string {
  const { mismatch } = event
  const target =
    mismatch.kind === 'silent-fallback'
      ? mismatch.effective
      : mismatch.kind === 'suboptimal-config'
        ? mismatch.ideal
        : mismatch.primaryDevice
  return `${event.provider}|${mismatch.kind}|${mismatch.configured}|${target}`
}

type SuppressedState = {
  suppressedPairs: string[]
  suppressPair: (pair: string) => void
}

const useSuppressedPairs = create<SuppressedState>()(
  persist(
    (set, get) => ({
      suppressedPairs: [],
      suppressPair: (pair: string) => {
        if (get().suppressedPairs.includes(pair)) return
        set({ suppressedPairs: [...get().suppressedPairs, pair] })
      },
    }),
    {
      name: localStorageKey.backendMismatchSuppressed,
      storage: createJSONStorage(() => localStorage),
    }
  )
)

type BackendMismatchState = {
  /** Latest mismatch reported by a load, waiting to be shown. */
  pending: BackendMismatchEvent | null
  /** Pair keys already shown in this app session. */
  shownThisSession: string[]
  setPending: (event: BackendMismatchEvent | null) => void
  report: (event: BackendRuntimeEvent) => void
  markShown: (pair: string) => void
}

const useBackendMismatchStore = create<BackendMismatchState>()((set, get) => ({
  pending: null,
  shownThisSession: [],
  setPending: (event) => set({ pending: event }),
  report: (event) => {
    const { mismatch } = event
    if (mismatch.kind === 'ok') {
      // This provider now runs as configured, so anything recorded for it —
      // including the notice shown in Settings — is stale. A verdict from a
      // different provider says nothing about this one.
      if (get().pending?.provider === event.provider) set({ pending: null })
      return
    }
    set({ pending: { ...event, mismatch } })
  },
  markShown: (pair: string) => {
    if (get().shownThisSession.includes(pair)) return
    set({ shownThisSession: [...get().shownThisSession, pair] })
  },
}))

export const useBackendMismatch = () => {
  const { pending, shownThisSession, setPending, report, markShown } =
    useBackendMismatchStore()
  const { suppressedPairs, suppressPair } = useSuppressedPairs()

  const pendingPair = pending ? mismatchPairKey(pending) : null
  const shouldPrompt =
    !!pendingPair &&
    !shownThisSession.includes(pendingPair) &&
    !suppressedPairs.includes(pendingPair)

  return {
    pending,
    /** True when there is a mismatch worth interrupting the user about. */
    shouldPrompt,
    /** Records a load's verdict: a mismatch to show, or `ok` to retire one. */
    report,
    /** Called when the dialog opens: at most one prompt per pair per session. */
    markShown: () => {
      if (pendingPair) markShown(pendingPair)
    },
    /** "Don't remind me" — persists for this pair only. */
    suppress: () => {
      if (pendingPair) {
        suppressPair(pendingPair)
        markShown(pendingPair)
      }
    },
    dismiss: () => setPending(null),
  }
}
