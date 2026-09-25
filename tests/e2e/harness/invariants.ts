/**
 * A test run must leave the operator's own Atomic Chat untouched. This watches
 * every place the app is known to write outside its data folder and fails the
 * run when one of them changes — on macOS that includes the WebKit stores,
 * which an unbundled binary would otherwise share with every dev build and
 * which a HOME redirect does not move. The list itself is a platform fact.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { operatorPaths } from './platform.js'

const MAX_DEPTH = 8

async function newestChange(path: string, depth = 0): Promise<number | null> {
  let info
  try {
    info = await stat(path)
  } catch {
    return null
  }
  let newest = info.mtimeMs
  if (info.isDirectory() && depth < MAX_DEPTH) {
    for (const entry of await readdir(path).catch(() => [] as string[])) {
      const child = await newestChange(join(path, entry), depth + 1)
      if (child !== null && child > newest) newest = child
    }
  }
  return newest
}

export type OperatorSnapshot = Map<string, number | null>

export async function snapshotOperatorState(): Promise<OperatorSnapshot> {
  const snapshot: OperatorSnapshot = new Map()
  for (const path of operatorPaths()) snapshot.set(path, await newestChange(path))
  return snapshot
}

/** Paths that appeared or changed since the snapshot; empty means untouched. */
export async function operatorStateChanges(before: OperatorSnapshot): Promise<string[]> {
  const changed: string[] = []
  for (const [path, was] of before) {
    const now = await newestChange(path)
    if (now !== was) changed.push(`${path} (${was === null ? 'created' : 'modified'})`)
  }
  return changed
}
