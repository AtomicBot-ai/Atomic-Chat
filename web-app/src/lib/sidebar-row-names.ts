/**
 * Telling sidebar rows apart when their names do not. A row shows only the
 * start of a long name, so chats (or projects) whose names start the same way
 * look the same; those rows also show when they were last active.
 */
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { intlLocale } from '@/lib/model-card'

/**
 * Roughly how much of a name the narrowest sidebar shows (14rem, Extra Large
 * text, the row's actions reserved). Names that agree this far collide; a
 * wider sidebar shows more, so the check errs on showing context.
 */
export const ROW_NAME_VISIBLE_PREFIX = 16

/** The part of a name a row is sure to show, compared case- and spacing-blind. */
export function rowNameKey(name: string): string {
  return (
    name
      // Search highlights wrap matches in <span>s.
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase()
      .slice(0, ROW_NAME_VISIBLE_PREFIX)
  )
}

/** Ids of the items whose name collides with another item's. */
export function collidingRowIds<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  nameOf: (item: T) => string
): Set<string> {
  const byKey = new Map<string, string[]>()
  for (const item of items) {
    const key = rowNameKey(nameOf(item))
    const ids = byKey.get(key)
    if (ids) ids.push(idOf(item))
    else byKey.set(key, [idOf(item)])
  }
  const colliding = new Set<string>()
  for (const ids of byKey.values()) {
    if (ids.length > 1) ids.forEach((id) => colliding.add(id))
  }
  return colliding
}

const threadCollisions = new WeakMap<object, Set<string>>()

/**
 * The chats whose titles collide, across every list the sidebar shows
 * (Pinned, Projects, Recents). Computed once per threads snapshot, so every
 * row can ask without walking the list again.
 */
export function collidingThreadIds(
  threads: Record<string, Thread>
): Set<string> {
  let ids = threadCollisions.get(threads)
  if (!ids) {
    ids = collidingRowIds(
      Object.values(threads).filter(
        (thread) => thread.id !== TEMPORARY_CHAT_ID
      ),
      (thread) => thread.id,
      (thread) => thread.title ?? ''
    )
    threadCollisions.set(threads, ids)
  }
  return ids
}

function dateFormat(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  try {
    // The app's own tags are not all BCP 47 (`vn` is Vietnamese).
    return new Intl.DateTimeFormat(locale && intlLocale(locale), options)
  } catch {
    return new Intl.DateTimeFormat(undefined, options)
  }
}

/**
 * When a row was last active, in the app's language: `short` fits beside the
 * name (the time today, the day this year, else the numeric date) and `full`
 * is the date and time for the tooltip.
 */
export function formatRowActivity(
  at: number,
  locale?: string,
  now: number = Date.now()
): { short: string; full: string; iso: string } {
  const date = new Date(at)
  const today = new Date(now)
  const sameYear = date.getFullYear() === today.getFullYear()
  const sameDay = sameYear && date.toDateString() === today.toDateString()
  const short = dateFormat(
    locale,
    sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : sameYear
        ? { month: 'short', day: 'numeric' }
        : { year: '2-digit', month: 'numeric', day: 'numeric' }
  ).format(date)
  const full = dateFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
  return { short, full, iso: date.toISOString() }
}
