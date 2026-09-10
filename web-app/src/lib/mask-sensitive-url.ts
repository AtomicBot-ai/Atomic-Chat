// List of sensitive query parameter names (matched case-insensitively).
const SENSITIVE_PARAMS = [
  'api_key',
  'apikey',
  'key',
  'token',
  'secret',
  'password',
  'pwd',
  'auth',
  'authorization',
  'bearer',
  'access_token',
  'refresh_token',
  'client_secret',
  'private_key',
  'signature',
  'hash',
]

/** Masks sensitive query parameters for display (`?key=...` → `?key=******`). */
export const maskSensitiveUrl = (url: string) => {
  if (!url) return url

  try {
    const urlObj = new URL(url)
    const params = urlObj.searchParams

    SENSITIVE_PARAMS.forEach((paramName) => {
      for (const [key] of params.entries()) {
        if (key.toLowerCase() === paramName.toLowerCase()) {
          params.set(key, '******')
        }
      }
    })

    urlObj.search = params.toString()
    return urlObj.toString()
  } catch {
    // If URL parsing fails, just mask the entire query string after '?'
    const queryIndex = url.indexOf('?')
    if (queryIndex === -1) return url

    return url.substring(0, queryIndex + 1) + '******'
  }
}
