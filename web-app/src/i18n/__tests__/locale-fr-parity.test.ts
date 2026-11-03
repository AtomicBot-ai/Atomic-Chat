import { describe, it, expect } from 'vitest'

// French is kept complete: a key added to an English namespace needs its
// French text in the same change, or the French UI silently falls back to
// English (QA 2.2.29, B08).
const files = import.meta.glob<Record<string, unknown>>(
  '../../locales/{en,fr}/*.json',
  { eager: true, import: 'default' }
)

const flatten = (node: unknown, prefix = '', out: string[] = []) => {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out)
    }
  } else {
    out.push(prefix)
  }
  return out
}

const namespaces = (lng: string) =>
  Object.keys(files)
    .map((path) => path.match(new RegExp(`/${lng}/([^/]+)\\.json$`))?.[1])
    .filter((ns): ns is string => Boolean(ns))
    .sort()

describe('French locale', () => {
  it('has every English namespace', () => {
    expect(namespaces('fr')).toEqual(expect.arrayContaining(namespaces('en')))
  })

  it.each(namespaces('en'))('has every English key in %s', (ns) => {
    const fr = new Set(flatten(files[`../../locales/fr/${ns}.json`] ?? {}))
    const missing = flatten(files[`../../locales/en/${ns}.json`]).filter(
      (key) => !fr.has(key)
    )
    expect(missing).toEqual([])
  })
})
