/**
 * The embedding examples the app hands out: what the Hub shows after each
 * input prefix, and the commands the API page copies. Pure.
 *
 * The commands are POSIX shell, like the API page's other examples. The
 * image one reads a file the user names and streams the request through
 * stdin, so a large image never meets the shell's argument limit and no
 * placeholder is ever sent as if it were an image.
 */

/**
 * The text after each prefix in the examples. Not translated: it is API
 * input, and an English-only model must not be shown another language.
 */
export const EMBEDDING_EXAMPLE_TEXT = {
  query: 'Why is the sky blue?',
  document: 'Sunlight scatters in the atmosphere.',
} as const

/** Where the key goes when the server needs one; the API page says to replace it. */
export const API_KEY_PLACEHOLDER = 'YOUR_API_KEY'

/** The file the image command reads; the API page says to point it at a real one. */
export const IMAGE_FILE_PLACEHOLDER = 'photo.jpg'

/** Single-quoted for a POSIX shell. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** The `curl` that sends the body arriving on stdin (`body` omitted) or `body` itself. */
function curl(endpoint: string, authRequired: boolean, body?: unknown) {
  return [
    `curl -X POST ${shellQuote(endpoint)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    ...(authRequired
      ? [`  -H 'Authorization: Bearer ${API_KEY_PLACEHOLDER}' \\`]
      : []),
    body === undefined
      ? '  --data-binary @-'
      : `  -d ${shellQuote(JSON.stringify(body))}`,
  ].join('\n')
}

/**
 * A request that embeds one sample text, with the model's own query prefix
 * when it has one (and none forced on a model without), and the vector as
 * plain numbers.
 */
export function embeddingTextCommand(
  endpoint: string,
  modelId: string,
  queryPrefix: string,
  authRequired: boolean
): string {
  return curl(endpoint, authRequired, {
    model: modelId,
    input: `${queryPrefix}${EMBEDDING_EXAMPLE_TEXT.query}`,
    encoding_format: 'float',
  })
}

/**
 * A request that embeds the image file in `$IMAGE`: the JSON is printed
 * around the file's base64 (one line, as the engine's decoder needs) with
 * the type `file` reads from the bytes, and piped into `curl`. No comments:
 * zsh, macOS's shell, runs `#` as a command when pasted.
 */
export function embeddingImageCommand(
  endpoint: string,
  modelId: string,
  authRequired: boolean
): string {
  const head =
    '{"model":%s,"encoding_format":"float","input":[{"content":[{"type":"image_url","image_url":{"url":"data:%s;base64,'
  return [
    `IMAGE=${IMAGE_FILE_PLACEHOLDER}`,
    `{ printf ${shellQuote(head)} ${shellQuote(JSON.stringify(modelId))} "$(file -b --mime-type "$IMAGE")"`,
    `  base64 < "$IMAGE" | tr -d '\\n'`,
    `  printf '"}}]}]}'`,
    `} | ${curl(endpoint, authRequired)}`,
  ].join('\n')
}
