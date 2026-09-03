/**
 * Tauri Voice Service — desktop implementation.
 *
 * Thin wrapper over `tauri-plugin-atomic-audio`. Capture, VAD, WAV encoding and
 * the transcription POST all happen natively; audio bytes never cross the IPC
 * bridge (Tauri v2 serialises `Vec<u8>` as a JSON array of numbers, which would
 * make every phrase hundreds of kilobytes of JSON).
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'

import { DefaultVoiceService } from './default'
import type {
  MicPermission,
  StartVoiceSessionOptions,
  VoiceEvent,
  VoiceInputDevice,
  VoiceSessionInfo,
  VoiceStatus,
} from './types'

const PLUGIN = 'plugin:atomic-audio'

/** Event name → the discriminant we hand the UI. */
const EVENT_MAP = {
  'atomic-audio://state': 'state',
  'atomic-audio://level': 'level',
  'atomic-audio://segment': 'segment',
  'atomic-audio://transcript': 'transcript',
  'atomic-audio://error': 'error',
} as const

/**
 * Deep links to the OS microphone privacy pane. macOS only prompts once, so a
 * user who denied needs a way back that does not involve hunting through
 * System Settings.
 */
const SETTINGS_URI: Record<string, string> = {
  macos: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  windows: 'ms-settings:privacy-microphone',
}

function currentOs(): string {
  if (IS_MACOS) return 'macos'
  if (IS_WINDOWS) return 'windows'
  return 'linux'
}

export class TauriVoiceService extends DefaultVoiceService {
  override isSupported(): boolean {
    return true
  }

  override async listInputDevices(): Promise<VoiceInputDevice[]> {
    return invoke<VoiceInputDevice[]>(`${PLUGIN}|list_input_devices`)
  }

  override async getPermission(): Promise<MicPermission> {
    return invoke<MicPermission>(`${PLUGIN}|get_microphone_permission`)
  }

  override async requestPermission(): Promise<MicPermission> {
    return invoke<MicPermission>(`${PLUGIN}|request_microphone_permission`)
  }

  override canOpenSystemMicrophoneSettings(): boolean {
    // Linux has no universal privacy URI; the recovery card falls back to text.
    return Boolean(SETTINGS_URI[currentOs()])
  }

  override async openSystemMicrophoneSettings(): Promise<void> {
    const uri = SETTINGS_URI[currentOs()]
    if (!uri) {
      throw new Error('This system has no microphone settings page to open.')
    }
    await openUrl(uri)
  }

  override async startSession(
    options: StartVoiceSessionOptions
  ): Promise<VoiceSessionInfo> {
    return invoke<VoiceSessionInfo>(`${PLUGIN}|start_dictation`, {
      options: {
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
        language: options.language,
        prompt: options.prompt,
        deviceId: options.deviceId ?? undefined,
        requestTimeoutSecs: options.requestTimeoutSecs,
      },
    })
  }

  override async stopSession(sessionId: string): Promise<void> {
    await invoke(`${PLUGIN}|stop_dictation`, { sessionId })
  }

  override async cancelSession(sessionId: string): Promise<void> {
    await invoke(`${PLUGIN}|cancel_dictation`, { sessionId })
  }

  override async getStatus(): Promise<VoiceStatus> {
    return invoke<VoiceStatus>(`${PLUGIN}|get_dictation_status`)
  }

  override async setTranscriptionTarget(
    sessionId: string,
    target: { baseUrl: string; apiKey: string; model: string }
  ): Promise<void> {
    await invoke(`${PLUGIN}|set_transcription_target`, {
      sessionId,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
    })
  }

  override subscribe(handler: (event: VoiceEvent) => void): () => void {
    const pending: Promise<UnlistenFn>[] = []

    for (const [name, type] of Object.entries(EVENT_MAP)) {
      pending.push(
        listen<Record<string, unknown>>(name, (event) => {
          handler({ ...event.payload, type } as VoiceEvent)
        })
      )
    }

    return () => {
      // A listener whose registration is still in flight must still be torn
      // down, so wait for each promise rather than dropping it.
      for (const promise of pending) {
        promise.then((unlisten) => unlisten()).catch(() => {})
      }
    }
  }
}
