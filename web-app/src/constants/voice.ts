/**
 * Voice input (dictation) constants.
 *
 * Transcription runs on the bundled upstream llama.cpp engine, which already
 * serves an OpenAI-compatible `/v1/audio/transcriptions` endpoint and already
 * carries the `voxtral` audio projector in its `libmtmd`. The only thing the
 * user has to fetch is the model itself.
 */

/** The provider the voice model is downloaded into and started on. */
export const VOICE_PROVIDER = 'llamacpp-upstream'

/**
 * Model id, also the llama-server alias (`-a`). Must satisfy the import
 * validator (`/^[a-zA-Z0-9/_\-\.]+$/`) and the download-task-id sanitiser.
 */
export const VOICE_MODEL_ID = 'ggml-org/Voxtral-Mini-3B-2507-Q4_K_M'

export const VOICE_MODEL_HF_REPO = 'ggml-org/Voxtral-Mini-3B-2507-GGUF'

const VOICE_MODEL_HF_BASE = `https://huggingface.co/${VOICE_MODEL_HF_REPO}/resolve/main`

export const VOICE_MODEL_URL = `${VOICE_MODEL_HF_BASE}/Voxtral-Mini-3B-2507-Q4_K_M.gguf`
export const VOICE_MMPROJ_URL = `${VOICE_MODEL_HF_BASE}/mmproj-Voxtral-Mini-3B-2507-Q8_0.gguf`

/** Display name on the model card. */
export const VOICE_MODEL_NAME = 'Voxtral Mini 3B'

/**
 * Exact on-disk size of both files, from the HF API. Everything the user sees
 * derives from this one number: the app renders GB as `bytes / 1024 ** 3`
 * (`renderGB`, `formatBytes`), so a hardcoded decimal-GB label would disagree
 * with the progress bar counting up beside it.
 */
export const VOICE_MODEL_BYTES = 2_473_001_920 + 715_714_080

/** Free disk space we tell the user to have on hand, rounded up from the above. */
export const VOICE_MODEL_FREE_DISK_GB = 4

/** Language hints offered in settings. `auto` lets the model decide per phrase. */
export const VOICE_LANGUAGES = ['auto', 'en', 'ru'] as const
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]

/**
 * Phases in which the microphone is live and the composer should show the
 * recording bar. Kept here so `ChatInput` does not have to import the store's
 * internals just to answer "is this composer recording?".
 */
export const VOICE_ACTIVE_PHASES = new Set([
  'starting',
  'listening',
  'transcribing',
  'finalizing',
])
