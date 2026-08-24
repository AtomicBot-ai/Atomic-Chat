/**
 * Voice-input error codes and their user-facing i18n keys.
 *
 * The codes are produced by the Rust audio plugin (`atomic-audio://error`) and
 * by the model/engine layer. Keeping the mapping in one place means a new code
 * cannot reach the UI as a raw SCREAMING_SNAKE string.
 */

export const VOICE_ERROR_CODES = [
  'permission',
  'noDevice',
  'deviceBusy',
  'deviceDisconnected',
  'modelMissing',
  'engineFailed',
  'transcriptionFailed',
  'transcriptionUnsupported',
  'transcriptionTimeout',
  'internal',
] as const

export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number]

/** Rust `AudioErrorCode` (serialised SCREAMING_SNAKE) → our camelCase code. */
const NATIVE_CODE_MAP: Record<string, VoiceErrorCode> = {
  PERMISSION_DENIED: 'permission',
  NO_INPUT_DEVICE: 'noDevice',
  DEVICE_UNAVAILABLE: 'deviceBusy',
  DEVICE_DISCONNECTED: 'deviceDisconnected',
  ALREADY_ACTIVE: 'internal',
  SESSION_NOT_FOUND: 'internal',
  SERVER_UNREACHABLE: 'engineFailed',
  TRANSCRIPTION_FAILED: 'transcriptionFailed',
  TRANSCRIPTION_UNSUPPORTED: 'transcriptionUnsupported',
  TRANSCRIPTION_TIMEOUT: 'transcriptionTimeout',
  INTERNAL: 'internal',
}

export function voiceErrorFromNative(code: string | undefined): VoiceErrorCode {
  if (!code) return 'internal'
  return NATIVE_CODE_MAP[code] ?? 'internal'
}

/** i18n key for a code, e.g. `common:voiceInput.errors.permission`. */
export function voiceErrorMessageKey(code: VoiceErrorCode): string {
  return `common:voiceInput.errors.${code}`
}

/**
 * Codes that end the session rather than letting it keep listening. A failed
 * phrase is recoverable; a missing microphone or an engine that cannot run the
 * audio projector is not.
 */
const TERMINAL_CODES = new Set<VoiceErrorCode>([
  'permission',
  'noDevice',
  'deviceBusy',
  'deviceDisconnected',
  'modelMissing',
  'engineFailed',
  'transcriptionUnsupported',
  'internal',
])

export function isTerminalVoiceError(code: VoiceErrorCode): boolean {
  return TERMINAL_CODES.has(code)
}
