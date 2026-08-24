/**
 * The voice model.
 *
 * Voice input transcribes on the same bundled llama.cpp engine that runs chat:
 * its `libmtmd` already carries the `voxtral` audio projector, and `llama-server`
 * already serves an OpenAI-compatible `/v1/audio/transcriptions`. So the model
 * is the only thing that has to be fetched, and it goes through the ordinary
 * download pipeline like any other GGUF.
 *
 * One model, deliberately. A tier picker would be a second thing to explain in
 * the setup wizard, and the sizes here are already dominated by the weights.
 */

/** Model id, and the llama-server alias (`-a`) it is loaded under. */
export const TRANSCRIPTION_MODEL_ID = 'ggml-org/Voxtral-Mini-3B-2507-Q4_K_M'

export const TRANSCRIPTION_MODEL_HF_REPO = 'ggml-org/Voxtral-Mini-3B-2507-GGUF'

const HF_BASE = `https://huggingface.co/${TRANSCRIPTION_MODEL_HF_REPO}/resolve/main`

export const TRANSCRIPTION_MODEL_URL = `${HF_BASE}/Voxtral-Mini-3B-2507-Q4_K_M.gguf`
export const TRANSCRIPTION_MMPROJ_URL = `${HF_BASE}/mmproj-Voxtral-Mini-3B-2507-Q8_0.gguf`

/** Exact sizes from the Hugging Face API, so the progress bar has a real total. */
export const TRANSCRIPTION_MODEL_BYTES = 2_473_001_920
export const TRANSCRIPTION_MMPROJ_BYTES = 715_714_080
export const TRANSCRIPTION_TOTAL_BYTES =
  TRANSCRIPTION_MODEL_BYTES + TRANSCRIPTION_MMPROJ_BYTES

/**
 * Load overrides for the voice server.
 *
 * Deliberately small and deterministic: one 30 s `libmtmd` audio window is a few
 * hundred tokens, a transcript is never long, and this process runs *alongside*
 * the user's chat model — so it must not size itself to the free VRAM the way a
 * chat load does.
 */
export const TRANSCRIPTION_LOAD_OVERRIDES = {
  fit: false,
  ctx_size: 4096,
  n_predict: 512,
  parallel: 1,
  cont_batching: false,
  // Warmup would generate a throwaway token through the audio path for no
  // benefit; the first real segment arrives seconds later anyway.
  extra_args: '--no-warmup',
} as const

/** Unload the voice model after this long without a phrase. */
export const TRANSCRIPTION_IDLE_UNLOAD_MS = 5 * 60_000
