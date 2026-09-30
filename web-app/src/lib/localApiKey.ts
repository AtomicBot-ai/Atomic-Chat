/** Marks a key as one of ours when it turns up in another app's settings. */
export const LOCAL_API_KEY_PREFIX = 'sk-atomic-'

/**
 * A key for the Local API Server: `sk-atomic-` plus 32 URL-safe characters.
 *
 * 24 random bytes are 192 bits and encode to exactly 32 base64 characters, so
 * there is no `=` padding to strip. The URL-safe alphabet keeps the key intact
 * when it is pasted into a shell, a header or a query string.
 */
export function generateLocalApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return (
    LOCAL_API_KEY_PREFIX +
    btoa(binary).replace(/\+/g, '-').replace(/\//g, '_')
  )
}
