/**
 * The language directive sent with every dictated phrase.
 *
 * Voxtral's transcription mode takes the output language as a `lang:xx` token
 * placed immediately before `[TRANSCRIBE]` (the voice server's chat template
 * appends the latter). llama.cpp's `/v1/audio/transcriptions` puts the caller's
 * `prompt` field exactly there, so the prompt *is* the directive — nothing else
 * is sent.
 *
 * It is not a hint. Without one the model treats the clip as English: Russian
 * speech comes back translated, and some clips come back empty. With one, it
 * transcribes verbatim in that language — and forces a *translation* if the
 * speaker used a different one. So the directive is always sent, and the only
 * question is where the code comes from.
 */

import type { VoiceLanguage } from '@/constants/voice'

/**
 * `auto` has no model-side equivalent, so it resolves to the language the app
 * itself is in — the best prior available for what the user is about to say,
 * and right for anyone whose interface language is their speaking language.
 */
export const FALLBACK_TRANSCRIPTION_LANGUAGE = 'en'

/**
 * Base subtag of a UI locale: `de-DE` → `de`, `zh-CN` → `zh`.
 *
 * `vn` is the app's (non-standard) tag for Vietnamese; Voxtral, like the rest
 * of the world, knows it as `vi`.
 */
function baseSubtag(uiLanguage: string): string {
  const base = uiLanguage.trim().toLowerCase().split(/[-_]/)[0]
  if (!base) return FALLBACK_TRANSCRIPTION_LANGUAGE
  return base === 'vn' ? 'vi' : base
}

/**
 * The `prompt` to send with a segment, given the user's language setting and
 * the language the app's interface is in.
 */
export function transcriptionPrompt(
  hint: VoiceLanguage,
  uiLanguage: string | undefined
): string {
  const code =
    hint === 'auto'
      ? baseSubtag(uiLanguage || FALLBACK_TRANSCRIPTION_LANGUAGE)
      : hint
  return `lang:${code}`
}
