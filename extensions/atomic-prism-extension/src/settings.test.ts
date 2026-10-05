import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The core imports this provider's settings from the app and checks them
// against its own schema, so the two files must stay byte-for-byte equal. The
// core checkout is found the way `tests/core-settings-schema.test.mjs` finds
// it: `ATOMIC_CORE_SRC`, else the sibling `atomic-chat-core` folder.
const ownPath = join(__dirname, '..', 'settings.json')
const coreSchemaPath = process.env.ATOMIC_CORE_SRC
  ? join(process.env.ATOMIC_CORE_SRC, 'settings', 'schema', 'atomic-prism.json')
  : join(
      __dirname,
      '../../../../atomic-chat-core/src/settings/schema/atomic-prism.json'
    )

const own = JSON.parse(readFileSync(ownPath, 'utf8')) as Array<{ key: string }>

describe('settings.json', () => {
  it.skipIf(!existsSync(coreSchemaPath))(
    'is the core’s atomic-prism schema, byte for byte',
    () => {
      expect(readFileSync(ownPath, 'utf8')).toBe(readFileSync(coreSchemaPath, 'utf8'))
    }
  )

  it('carries the candidate-build gate and none of the removed features', () => {
    const keys = own.map((s) => s.key)
    expect(keys).toContain('allow_candidate_builds')
    expect(keys).toContain('version_backend')
    for (const removed of ['mtp', 'dflash', 'dflash_block_size', 'split_mode', 'main_gpu']) {
      expect(keys).not.toContain(removed)
    }
  })
})
