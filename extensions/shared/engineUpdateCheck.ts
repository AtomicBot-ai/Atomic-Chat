/**
 * The deadline of the manual "check for engine updates" lookup, shared by the
 * llama.cpp, TurboQuant and PrismML extensions.
 *
 * Unlike the startup reconciliation, which may treat a failed lookup as "no
 * update" and move on, the manual check answers a person: a lookup that
 * failed or never answered must reject, so the caller says the check failed
 * instead of calling an unchecked engine up to date.
 */

export const ENGINE_UPDATE_CHECK_TIMEOUT_MS = 20_000

/** `lookup`, or a rejection once `ms` pass without an answer. */
export function withEngineUpdateDeadline<T>(
  lookup: Promise<T>,
  ms = ENGINE_UPDATE_CHECK_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `The engine release index did not answer within ${Math.round(ms / 1000)} seconds.`
          )
        ),
      ms
    )
  })
  return Promise.race([lookup, deadline]).finally(() => clearTimeout(timer))
}
