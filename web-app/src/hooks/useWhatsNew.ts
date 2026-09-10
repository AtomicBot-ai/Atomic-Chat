import { useCallback, useEffect, useRef, useState } from 'react'
import { useLastSeenVersion } from './useLastSeenVersion'

const GITHUB_REPO = 'AtomicBot-ai/Atomic-Chat'

type GithubRelease = {
  tag_name: string
  name?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  html_url?: string
}

/**
 * Compare two semver-like strings (MAJOR.MINOR.PATCH, with optional leading "v").
 * Returns -1 if a < b, 0 if equal, 1 if a > b. Missing parts treated as 0.
 * Pre-release suffixes (e.g. "1.2.3-beta.1") are stripped before numeric compare.
 */
export const compareSemver = (a: string, b: string): number => {
  const normalize = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((part) => {
        const n = parseInt(part, 10)
        return Number.isFinite(n) ? n : 0
      })

  const pa = normalize(a)
  const pb = normalize(b)
  const len = Math.max(pa.length, pb.length, 3)

  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

const getRuntimeVersion = async (): Promise<string> => {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    const v = await getVersion()
    if (v && v !== '0.0.0') return v
  } catch {
    // Not running inside Tauri (e.g. dev web) — fall back below.
  }
  return typeof VERSION === 'string' ? VERSION : '0.0.0'
}

const fetchReleaseByTag = async (
  tag: string
): Promise<GithubRelease | null> => {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${tag}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
        },
      }
    )
    if (!res.ok) return null
    const data = (await res.json()) as GithubRelease
    if (data.draft || data.prerelease) return null
    return data
  } catch {
    return null
  }
}

export type WhatsNewState = {
  open: boolean
  currentVersion: string
  release: GithubRelease | null
  acknowledge: () => void
  githubUrl: string | null
}

/**
 * Orchestrates the post-update "What's new" popup:
 * - Reads runtime app version (Tauri getVersion() with VERSION fallback).
 * - Compares to persisted lastSeenVersion (zustand + localStorage).
 * - On fresh install: silently records currentVersion.
 * - On upgrade: fetches GitHub release by tag; if stable, opens the dialog.
 * - On downgrade / equal / failed fetch: silently records currentVersion without UI.
 */
export const useWhatsNew = (): WhatsNewState => {
  const { lastSeenVersion, setLastSeenVersion } = useLastSeenVersion()
  const [currentVersion, setCurrentVersion] = useState<string>('')
  const [release, setRelease] = useState<GithubRelease | null>(null)
  const [open, setOpen] = useState(false)
  const didRunRef = useRef(false)

  useEffect(() => {
    // Guard against StrictMode double-invocation in dev. The ref persists
    // across the simulated unmount/remount because StrictMode reuses the
    // component instance. No `cancelled` flag here: the async work is
    // short-lived, idempotent on the persisted marker, and setting state
    // on an (already) unmounted component is a no-op in React 18+.
    if (didRunRef.current) return
    didRunRef.current = true

    const run = async () => {
      const version = await getRuntimeVersion()
      setCurrentVersion(version)

      if (!lastSeenVersion) {
        setLastSeenVersion(version)
        return
      }

      const cmp = compareSemver(version, lastSeenVersion)
      if (cmp === 0) return

      if (cmp < 0) {
        setLastSeenVersion(version)
        return
      }

      const tag = version.startsWith('v') ? version : `v${version}`
      const rel = await fetchReleaseByTag(tag)

      if (!rel || !rel.body) {
        setLastSeenVersion(version)
        return
      }

      setRelease(rel)
      setOpen(true)
    }

    run()
    // Intentionally run once on mount; ref guards StrictMode double-call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const acknowledge = useCallback(() => {
    setOpen(false)
    if (currentVersion) setLastSeenVersion(currentVersion)
  }, [currentVersion, setLastSeenVersion])

  const githubUrl = currentVersion
    ? `https://github.com/${GITHUB_REPO}/releases/tag/${
        currentVersion.startsWith('v') ? currentVersion : `v${currentVersion}`
      }`
    : null

  return { open, currentVersion, release, acknowledge, githubUrl }
}
