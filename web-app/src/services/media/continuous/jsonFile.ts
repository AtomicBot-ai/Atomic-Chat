/** Small atomic JSON/text helpers over the media filesystem seam. */
import type { MediaFileSystem } from '../assets'

const encoder = new TextEncoder()

export async function writeTextAtomic(fs: MediaFileSystem, path: string, text: string): Promise<void> {
  const temp = `${path}.tmp`
  await fs.writeBytes(temp, encoder.encode(text))
  if (await fs.exists(path)) await fs.remove(path)
  await fs.rename(temp, path)
}

export async function readJson<T>(fs: MediaFileSystem, path: string): Promise<T | undefined> {
  if (!(await fs.exists(path))) return undefined
  try {
    return JSON.parse(await fs.readText(path)) as T
  } catch {
    return undefined
  }
}
