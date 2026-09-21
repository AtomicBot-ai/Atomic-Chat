/**
 * Once per run, before any worker starts: clear away what earlier runs that
 * were cut short left behind. It cannot be done per session any more — a root
 * that no process names yet is exactly what a neighbouring worker's profile
 * looks like while it is being prepared.
 */
import { sweepStaleProfiles } from './profile.js'

export default async function setup(): Promise<void> {
  const removed = await sweepStaleProfiles()
  if (removed.length > 0) console.log(`swept ${removed.length} stale e2e profile(s)`)
}
