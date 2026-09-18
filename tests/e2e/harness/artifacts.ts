/**
 * What a failed scenario leaves behind, so the failure can be read without
 * re-running it: what the window showed, what the page contained, what the app
 * and the core logged. Collected before teardown deletes the profile.
 */
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunningApp } from './app.js'
import { listProcesses } from './platform.js'

export const ARTIFACTS_ROOT = join(import.meta.dirname, '..', '.artifacts')

export async function captureFailure(
  name: string,
  app: RunningApp | undefined,
  dataFolder: string
): Promise<string> {
  const dir = join(ARTIFACTS_ROOT, name)
  await mkdir(dir, { recursive: true })
  const attempt = async (what: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      await writeFile(join(dir, `${what}.error.txt`), String(error))
    }
  }
  if (app) {
    await attempt('screenshot', async () => {
      await app.browser.saveScreenshot(join(dir, 'screen.png'))
    })
    await attempt('page', async () => {
      const page = await app.browser.execute(() => ({
        url: location.href,
        text: document.body.innerText,
        storageKeys: Object.keys(localStorage),
        errors: (window as unknown as { __atomic_e2e_errors?: string[] }).__atomic_e2e_errors ?? null,
        console: (window as unknown as { __atomic_e2e_console?: string[] }).__atomic_e2e_console ?? null,
      }))
      await writeFile(join(dir, 'page.json'), JSON.stringify(page, null, 2))
    })
    await writeFile(join(dir, 'app-output.log'), app.output())
  }
  // The argv the core chose for its backends, and who was still running.
  await attempt('processes', () =>
    writeFile(
      join(dir, 'processes.txt'),
      listProcesses()
        .filter((p) => p.command.includes(dataFolder))
        .map((p) => `${p.pid} ${p.command}`)
        .join('\n')
    )
  )
  await attempt('logs', () => cp(join(dataFolder, 'logs'), join(dir, 'logs'), { recursive: true }))
  await attempt('core', () =>
    cp(join(dataFolder, 'atomic-core'), join(dir, 'atomic-core'), {
      recursive: true,
      // The control token authorises the control API; it does not belong in an artifact.
      filter: (source) => !source.endsWith('control-token'),
    })
  )
  return dir
}
