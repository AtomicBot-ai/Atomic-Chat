/** `{{repo}}`-style placeholders in a body, in order, without repeats. */
export function promptVariables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]!))]
}
