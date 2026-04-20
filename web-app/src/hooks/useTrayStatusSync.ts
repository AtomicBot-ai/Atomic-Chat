import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useShallow } from 'zustand/react/shallow'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'

type SystemUsage = {
  cpu: number
  used_memory: number
  total_memory: number
}

type MlxSession = {
  pid: number
  port: number
  model_id: string
  model_path: string
  is_embedding: boolean
  api_key: string
}

type TrayStatusPayload = {
  server_running: boolean
  server_url: string
  model_label: string
  ram_used_mb: number
  ram_total_mb: number
  ram_percent: number
}

const TRAY_REFRESH_MS = 5000

/**
 * Push live status into the macOS menu-bar tray every 5 s.
 *
 * The backing Rust command ({@link ../../../src-tauri/src/core/tray_status.rs `update_tray_status`})
 * is a no-op when the tray was never installed (non-macOS builds without the
 * `ENABLE_SYSTEM_TRAY_ICON` env gate), so this hook is safe to mount unconditionally
 * inside Tauri — but we still short-circuit on web and non-macOS to avoid
 * unnecessary IPC chatter.
 */
export function useTrayStatusSync(): void {
  const { serverStatus, activeModels } = useAppState(
    useShallow((state) => ({
      serverStatus: state.serverStatus,
      activeModels: state.activeModels,
    }))
  )
  const { serverPort, apiPrefix } = useLocalApiServer(
    useShallow((state) => ({
      serverPort: state.serverPort,
      apiPrefix: state.apiPrefix,
    }))
  )

  // Ref so the interval callback always observes the latest values without
  // restarting the timer on every dependency change.
  const latest = useRef({ serverStatus, activeModels, serverPort, apiPrefix })
  latest.current = { serverStatus, activeModels, serverPort, apiPrefix }

  useEffect(() => {
    if (!IS_TAURI || !IS_MACOS) return

    let cancelled = false

    const push = async () => {
      if (cancelled) return
      try {
        const current = latest.current
        const [usage, sessions] = await Promise.all([
          invoke<SystemUsage>('plugin:hardware|get_system_usage').catch(
            () => null
          ),
          invoke<MlxSession[]>('plugin:mlx|get_mlx_all_sessions').catch(
            () => [] as MlxSession[]
          ),
        ])

        // Prefer an active MLX session (authoritative: a running inference process),
        // fall back to `activeModels` which also tracks non-MLX engines.
        const modelLabel = (() => {
          const nonEmbedding = sessions.filter((s) => !s.is_embedding)
          if (nonEmbedding.length === 1) return nonEmbedding[0].model_id
          if (nonEmbedding.length > 1)
            return `${nonEmbedding.length} models loaded`
          if (current.activeModels.length === 1) return current.activeModels[0]
          if (current.activeModels.length > 1)
            return `${current.activeModels.length} models loaded`
          return ''
        })()

        const ramUsed = usage?.used_memory ?? 0
        const ramTotal = usage?.total_memory ?? 0
        const ramPercent =
          ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0

        const payload: TrayStatusPayload = {
          server_running: current.serverStatus === 'running',
          server_url: `http://127.0.0.1:${current.serverPort}${current.apiPrefix}`,
          model_label: modelLabel,
          ram_used_mb: ramUsed,
          ram_total_mb: ramTotal,
          ram_percent: ramPercent,
        }

        await invoke('update_tray_status', { payload })
      } catch (err) {
        // Tray is optional UI; never surface errors to the user.
        if (IS_DEV) console.debug('[tray] update failed', err)
      }
    }

    push()
    const id = setInterval(push, TRAY_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // Re-run whenever any of the status inputs change so the tray reflects
    // transitions (server start/stop, model switch) without waiting up to 5 s.
  }, [serverStatus, activeModels, serverPort, apiPrefix])
}
