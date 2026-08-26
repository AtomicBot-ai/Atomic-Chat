/**
 * Voice Service Types
 *
 * The seam between the composer and the native audio plugin. Capture, VAD and
 * the transcription request all live in Rust (`tauri-plugin-atomic-audio`);
 * this interface is the whole surface the UI touches.
 */

/** Mirrors the plugin's `MicPermission`. */
export type MicPermission = 'granted' | 'denied' | 'undetermined' | 'unsupported'

export type VoiceInputDevice = {
  /** Stable `cpal::DeviceId`, persistable. Null when the host cannot supply one. */
  id: string | null
  name: string
  isDefault: boolean
  /** True when the device speaks 16 kHz natively, so no resampling is needed. */
  supports16k: boolean
  defaultSampleRate: number
  channels: number
}

export type VoiceSessionInfo = {
  sessionId: string
  deviceId: string | null
  deviceName: string
  sampleRate: number
  resampled: boolean
  /** The requested device was gone and we fell back to the system default. */
  fellBackToDefault: boolean
}

export type VoiceSessionState = 'starting' | 'recording' | 'stopping' | 'stopped'

/** Native error codes, SCREAMING_SNAKE from the plugin. */
export type NativeVoiceErrorCode =
  | 'PERMISSION_DENIED'
  | 'NO_INPUT_DEVICE'
  | 'DEVICE_UNAVAILABLE'
  | 'DEVICE_DISCONNECTED'
  | 'ALREADY_ACTIVE'
  | 'SESSION_NOT_FOUND'
  | 'SERVER_UNREACHABLE'
  | 'TRANSCRIPTION_FAILED'
  | 'TRANSCRIPTION_UNSUPPORTED'
  | 'TRANSCRIPTION_TIMEOUT'
  | 'INTERNAL'

export type VoiceEvent =
  | { type: 'state'; sessionId: string; state: VoiceSessionState; reason?: string }
  | {
      type: 'level'
      sessionId: string
      /** Linear RMS, 0..1. */
      rms: number
      db: number
      speaking: boolean
      elapsedMs: number
    }
  | {
      type: 'segment'
      sessionId: string
      index: number
      startMs: number
      endMs: number
      durationMs: number
    }
  | {
      type: 'transcript'
      sessionId: string
      index: number
      text: string
      durationMs: number
      latencyMs: number
    }
  | {
      type: 'error'
      sessionId?: string
      code: NativeVoiceErrorCode
      message: string
      details?: string
    }

export type StartVoiceSessionOptions = {
  /**
   * Where to send audio. Leave all three out for a monitor-only session: the
   * microphone opens and level events flow, but nothing is transcribed — which
   * is how the settings page tests a device without needing the voice model
   * installed.
   */
  baseUrl?: string
  apiKey?: string
  /** llama-server alias, which is the model id. */
  model?: string
  /** ISO-639-1 hint, or `auto`. */
  language?: string
  /** Optional biasing text. */
  prompt?: string
  deviceId?: string | null
  requestTimeoutSecs?: number
}

export type VoiceStatus = {
  active: boolean
  sessionId: string | null
  deviceName: string | null
  elapsedMs: number
  segmentsClosed: number
  segmentsTranscribed: number
  droppedFrames: number
}

export interface VoiceService {
  /** True when this build can capture audio at all. */
  isSupported(): boolean

  listInputDevices(): Promise<VoiceInputDevice[]>

  /** Current permission, without prompting. */
  getPermission(): Promise<MicPermission>
  /** Prompt if the OS supports it, then report the outcome. */
  requestPermission(): Promise<MicPermission>
  /** True when this OS has a settings pane we can deep-link to. */
  canOpenSystemMicrophoneSettings(): boolean
  openSystemMicrophoneSettings(): Promise<void>

  startSession(options: StartVoiceSessionOptions): Promise<VoiceSessionInfo>
  /** Stop and transcribe the tail phrase. */
  stopSession(sessionId: string): Promise<void>
  /** Stop and discard the tail phrase. */
  cancelSession(sessionId: string): Promise<void>
  getStatus(): Promise<VoiceStatus>

  /** Re-point a live session at a restarted server. */
  setTranscriptionTarget(
    sessionId: string,
    target: { baseUrl: string; apiKey: string; model: string }
  ): Promise<void>

  /** Subscribe to session events. Returns an unsubscribe function. */
  subscribe(handler: (event: VoiceEvent) => void): () => void
}
