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
 * Chat template the voice server is loaded with.
 *
 * Two things make this mandatory rather than a nicety.
 *
 * 1. The template embedded in `ggml-org/Voxtral-Mini-3B-2507-Q4_K_M.gguf` is an
 *    Unsloth *Devstral* template. It defaults every conversation to a ~1200
 *    token "You are Devstral, a helpful agentic model … using the OpenHands
 *    scaffold" system prompt, which llama.cpp then prepends to every
 *    `/v1/audio/transcriptions` request (that endpoint is a chat completion
 *    underneath). The model duly behaves like a chat agent: it *hears* the
 *    audio and answers it — "I'm unable to transcribe audio directly. However,
 *    I can guide you on how to use Descript, Rev, Amazon Transcribe…" — instead
 *    of transcribing. Every phrase then trips the plugin's plausibility guard
 *    and is dropped, so dictation inserts nothing at all.
 *
 * 2. Voxtral has a dedicated transcription mode, entered by ending the user
 *    turn with the `[TRANSCRIBE]` token instead of closing it with `[/INST]`.
 *    Closing the turn normally — with or without a "transcribe this" prompt —
 *    leaves the model in conversational mode, where it answers, refuses, or
 *    returns nothing depending on the clip.
 *
 * So: no system prompt, and `[INST]` … `[TRANSCRIBE]` around whatever the
 * endpoint puts in the user turn (the audio marker, then the caller's `prompt`,
 * which is where the `lang:xx` directive lands). This server only ever serves
 * transcription, so treating every message as a transcription turn is honest.
 *
 * `String.raw` for consistency with `chatTemplateOverrides.ts`: minja, not JS,
 * interprets any escapes inside the Jinja source.
 */
export const VOXTRAL_TRANSCRIPTION_CHAT_TEMPLATE =
  String.raw`{%- for message in messages %}
    {%- set content = namespace(text='') %}
    {%- if message['content'] is string %}
        {%- set content.text = message['content'] %}
    {%- else %}
        {%- for block in message['content'] %}
            {%- if block['type'] == 'text' %}
                {%- set content.text = content.text + block['text'] %}
            {%- endif %}
        {%- endfor %}
    {%- endif %}
    {%- if message['role'] == 'assistant' %}
        {{- content.text }}{{- eos_token }}
    {%- else %}
        {{- '[INST]' + content.text + '[TRANSCRIBE]' }}
    {%- endif %}
{%- endfor %}`

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
  // Not optional — see the constant's own note. Without it the model answers
  // the audio instead of transcribing it and dictation produces nothing.
  chat_template: VOXTRAL_TRANSCRIPTION_CHAT_TEMPLATE,
  // Warmup would generate a throwaway token through the audio path for no
  // benefit; the first real segment arrives seconds later anyway.
  extra_args: '--no-warmup',
} as const

/** Unload the voice model after this long without a phrase. */
export const TRANSCRIPTION_IDLE_UNLOAD_MS = 5 * 60_000
