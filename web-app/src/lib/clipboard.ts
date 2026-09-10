/**
 * Clipboard writes reject far more often than they look like they should: the
 * Tauri webview denies them whenever the document is not focused or the call
 * did not originate in a user gesture, and it surfaces that as a
 * `NotAllowedError`. Several call sites fired `navigator.clipboard.writeText`
 * without awaiting it, so the rejection escaped as an unhandled rejection and
 * was reported as a crash — while the button still flipped to its "copied"
 * state and told the user the opposite of what happened.
 *
 * This helper reports the outcome instead of throwing, so callers can show a
 * truthful confirmation.
 *
 * @returns `true` when the text reached the clipboard.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    // Denied clipboard access is a normal outcome of the environment, not a
    // defect worth filing: log it and let the caller degrade gracefully.
    console.warn('Failed to write to the clipboard', error)
    return false
  }
}
