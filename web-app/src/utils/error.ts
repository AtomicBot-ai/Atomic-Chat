export const OUT_OF_CONTEXT_SIZE =
  'the request exceeds the available context size.'

export const MODEL_ACCESS_DENIED_TITLE = 'Model not available for your API key'
export const MODEL_ACCESS_DENIED_MESSAGE =
  "This model needs to be enabled in your provider's key settings. Add it to the allowed models list and try again."

/**
 * Detects provider errors that occur when the API key is valid but does not
 * have permission to call the selected model. This happens most often with
 * OpenAI (newly released / gated models, project-scoped keys with an allow
 * list), but also with Anthropic, Gemini and xAI when a project / tier is
 * missing the right entitlement.
 *
 * We match against common wording instead of a specific error code because
 * different SDKs wrap the upstream response differently and the same class of
 * failure can surface with different shapes. Keep patterns lower-case and
 * narrow enough to avoid false positives for unrelated "not found" errors.
 */
export function isModelAccessError(error: unknown): boolean {
  if (!error) return false
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message?: unknown }).message ?? '')
          : ''
  if (!raw) return false
  const msg = raw.toLowerCase()

  // OpenAI: "The model `gpt-X` does not exist or you do not have access to it."
  if (
    msg.includes('does not exist or you do not have access') ||
    msg.includes('do not have access to') ||
    msg.includes("don't have access to") ||
    msg.includes('model_not_found') ||
    msg.includes("model doesn't exist") ||
    msg.includes('model does not exist')
  ) {
    return true
  }

  // Anthropic / Gemini / xAI flavours that imply a permission / entitlement
  // problem scoped to a model rather than a global auth failure.
  if (
    (msg.includes('permission') &&
      (msg.includes('model') || msg.includes('access'))) ||
    (msg.includes('not authorized') && msg.includes('model')) ||
    (msg.includes('not allowed') && msg.includes('model')) ||
    (msg.includes('unsupported') && msg.includes('model')) ||
    msg.includes('model is not available') ||
    msg.includes('model not available')
  ) {
    return true
  }

  return false
}
