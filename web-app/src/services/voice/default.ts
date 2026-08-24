/**
 * Default Voice Service — the no-op used on web and mobile.
 *
 * Voice input needs native microphone capture and a local llama.cpp server,
 * neither of which exists off the desktop. Rather than throwing on every call,
 * `isSupported()` returns false so the UI simply never renders the microphone.
 * The methods still reject, loudly, in case something calls them anyway.
 */

import type {
  MicPermission,
  StartVoiceSessionOptions,
  VoiceEvent,
  VoiceInputDevice,
  VoiceService,
  VoiceSessionInfo,
  VoiceStatus,
} from './types'

const UNSUPPORTED = 'Voice input is not available on this platform.'

export class DefaultVoiceService implements VoiceService {
  isSupported(): boolean {
    return false
  }

  async listInputDevices(): Promise<VoiceInputDevice[]> {
    return []
  }

  async getPermission(): Promise<MicPermission> {
    return 'unsupported'
  }

  async requestPermission(): Promise<MicPermission> {
    return 'unsupported'
  }

  canOpenSystemMicrophoneSettings(): boolean {
    return false
  }

  async openSystemMicrophoneSettings(): Promise<void> {
    throw new Error(UNSUPPORTED)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async startSession(_options: StartVoiceSessionOptions): Promise<VoiceSessionInfo> {
    throw new Error(UNSUPPORTED)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async stopSession(_sessionId: string): Promise<void> {
    throw new Error(UNSUPPORTED)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async cancelSession(_sessionId: string): Promise<void> {
    throw new Error(UNSUPPORTED)
  }

  async getStatus(): Promise<VoiceStatus> {
    return {
      active: false,
      sessionId: null,
      deviceName: null,
      elapsedMs: 0,
      segmentsClosed: 0,
      segmentsTranscribed: 0,
      droppedFrames: 0,
    }
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  async setTranscriptionTarget(
    _sessionId: string,
    _target: { baseUrl: string; apiKey: string; model: string }
  ): Promise<void> {
    /* eslint-enable @typescript-eslint/no-unused-vars */
    throw new Error(UNSUPPORTED)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  subscribe(_handler: (event: VoiceEvent) => void): () => void {
    return () => {}
  }
}
