import { beforeEach, describe, expect, it } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

import { TauriOpenerService } from '../tauri'

type Call = { command: string; args?: InvokeArgs }

describe('TauriOpenerService.revealItemInDir', () => {
  let calls: Call[]
  let fail: string | null

  beforeEach(() => {
    calls = []
    fail = null
    mockIPC((command: string, args?: InvokeArgs) => {
      calls.push({ command, args })
      if (fail) throw fail
      return null
    })
  })

  it("asks the app's own command, not the opener plugin's, to show the file", async () => {
    await new TauriOpenerService().revealItemInDir('/data/logs/app.log')

    // The plugin's reveal blocks on D-Bus inside the async runtime and aborts the app on Linux.
    expect(calls).toEqual([
      {
        command: 'reveal_in_file_manager',
        args: { path: '/data/logs/app.log' },
      },
    ])
  })

  it('passes a failed reveal on to the caller', async () => {
    fail = 'No file manager answered'

    await expect(
      new TauriOpenerService().revealItemInDir('/data/logs')
    ).rejects.toBe('No file manager answered')
  })
})
