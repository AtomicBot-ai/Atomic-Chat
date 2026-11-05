/** The token counts mlx-server reports with an answer (OpenAI `usage`). */
export interface MlxUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

/**
 * Whether an answer mlx-server ended with `finish_reason: "length"` ran out of
 * context, rather than reaching its `max_tokens`.
 *
 * mlx-server refuses a request whose prompt plus `max_tokens` does not fit
 * `--max-kv-size` before it generates anything (HTTP 400, "... but MAX_KV_SIZE
 * is N"), so an answer it accepted and cut short stopped at its `max_tokens`:
 * the request's own, or mlx-server's default of 2048 when the request names
 * none (#384). Only usage that fills the loaded window says the window ran
 * out; without usage or a known window, `length` is the answer's cap.
 */
export function isContextOverflowLength(
  usage: MlxUsage | null | undefined,
  windowTokens: number | undefined
): boolean {
  if (!windowTokens || windowTokens <= 0) return false
  const prompt = usage?.prompt_tokens
  const completion = usage?.completion_tokens
  if (typeof prompt !== 'number' || typeof completion !== 'number') return false
  return prompt + completion >= windowTokens
}
