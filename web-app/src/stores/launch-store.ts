/**
 * Zustand store holding the transient install / run state for the Launch page
 * integrations (busy, spinner, phase, install logs, detection results).
 *
 * This state used to live in `useState` inside `LaunchPage`, so navigating
 * away mid-install unmounted the component and dropped the in-flight progress;
 * the Rust installer kept running but the UI lost track of it and showed no
 * loader on return. Hoisting it into a module-level store lets it survive
 * route unmount/remount while still resetting on a full app reload (we
 * intentionally do NOT persist it to disk).
 *
 * Setters mimic React's `Dispatch<SetStateAction<T>>` so existing call sites
 * (`setBusy((prev) => ({ ...prev, [id]: true }))`) work unchanged.
 */

import { create } from 'zustand'
import { useApiServerLog } from '@/hooks/useApiServerLog'
import { useAppState } from '@/hooks/useAppState'
import { agentsWithRequests, type OpenedAgent } from '@/lib/agent-status'

export type RunPhase = 'installing' | 'configuring' | 'connecting' | undefined

type SetState<T> = (updater: T | ((prev: T) => T)) => void

function apply<T>(updater: T | ((prev: T) => T), prev: T): T {
  return typeof updater === 'function'
    ? (updater as (p: T) => T)(prev)
    : updater
}

type LaunchState = {
  installed: Record<string, boolean>
  /** True when the agent was only found inside a WSL distribution (Windows). */
  viaWsl: Record<string, boolean>
  /**
   * Absolute path to the launcher when it was found *off* PATH — a custom path,
   * or a prefix install like the one OpenClaw's desktop app creates under
   * `~/.openclaw/bin`. Absent when the bare binary name resolves on PATH.
   */
  binPath: Record<string, string | undefined>
  busy: Record<string, boolean>
  spinning: Record<string, boolean>
  phase: Record<string, RunPhase>
  logs: Record<string, string[]>
  openLog: Record<string, boolean>
  /**
   * Agents Atomic Chat opened (a terminal or their app) while the server
   * runs, with when and for which model. This records launch history, never
   * client liveness.
   */
  opened: Record<string, OpenedAgent>
  /**
   * Opened agents the server has seen a request from since they were opened
   * (`agentsWithRequests`). Kept once seen, so clearing the Activity log or
   * a flood of other requests does not take it back.
   */
  connected: Record<string, boolean>
  setInstalled: SetState<Record<string, boolean>>
  setViaWsl: SetState<Record<string, boolean>>
  setBinPath: SetState<Record<string, string | undefined>>
  setBusy: SetState<Record<string, boolean>>
  setSpinning: SetState<Record<string, boolean>>
  setPhase: SetState<Record<string, RunPhase>>
  setLogs: SetState<Record<string, string[]>>
  setOpenLog: SetState<Record<string, boolean>>
  /**
   * Record that `id` was opened for `model`. A new window starts over: until
   * the server hears from it, it is only opened. One brought forward
   * (`reopened`) is the same process, so what was known about it stays.
   */
  markOpened: (
    id: string,
    model: string | null,
    options?: { reopened?: boolean }
  ) => void
}

export const useLaunchStore = create<LaunchState>((set) => ({
  installed: {},
  viaWsl: {},
  binPath: {},
  busy: {},
  spinning: {},
  phase: {},
  logs: {},
  openLog: {},
  opened: {},
  connected: {},
  setInstalled: (updater) =>
    set((s) => ({ installed: apply(updater, s.installed) })),
  setViaWsl: (updater) => set((s) => ({ viaWsl: apply(updater, s.viaWsl) })),
  setBinPath: (updater) =>
    set((s) => ({ binPath: apply(updater, s.binPath) })),
  setBusy: (updater) => set((s) => ({ busy: apply(updater, s.busy) })),
  setSpinning: (updater) =>
    set((s) => ({ spinning: apply(updater, s.spinning) })),
  setPhase: (updater) => set((s) => ({ phase: apply(updater, s.phase) })),
  setLogs: (updater) => set((s) => ({ logs: apply(updater, s.logs) })),
  setOpenLog: (updater) =>
    set((s) => ({ openLog: apply(updater, s.openLog) })),
  markOpened: (id, model, options) =>
    set((s) => {
      if (options?.reopened && s.opened[id]) return s
      return {
        opened: { ...s.opened, [id]: { at: Date.now(), model } },
        connected: { ...s.connected, [id]: false },
      }
    }),
}))

useAppState.subscribe((state, previous) => {
  if (previous.serverStatus === 'running' && state.serverStatus !== 'running') {
    useLaunchStore.setState({ opened: {}, connected: {} })
  }
})

// Requests are credited as they arrive; the log is live for the whole app
// run (`useApiServerLogLive`).
useApiServerLog.subscribe((state, previous) => {
  if (state.entries === previous.entries) return
  const { opened, connected } = useLaunchStore.getState()
  if (Object.keys(opened).every((id) => connected[id])) return
  const heard = [...agentsWithRequests(opened, state.entries)].filter(
    (id) => !connected[id]
  )
  if (heard.length === 0) return
  useLaunchStore.setState((s) => ({
    connected: {
      ...s.connected,
      ...Object.fromEntries(heard.map((id) => [id, true])),
    },
  }))
})
