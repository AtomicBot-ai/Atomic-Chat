/**
 * MLX without MLX, and Apple's on-device model without Apple Intelligence. The
 * core starts `mlx-server` and `foundation-models-server` from the app's bundled
 * binaries folder, which for the e2e build is part of the build output and holds
 * empty placeholders. A scenario swaps a placeholder for a launcher of the
 * core's scripted sidecar and puts the placeholder back afterwards — the one
 * piece of state these tests keep outside a profile, confined to the e2e
 * target directory.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { APP_BINARY } from './app.js'
import { CORE_REPO } from './fixtures.js'
import type { Profile } from './profile.js'

export const MLX_PROVIDER = 'mlx'
export const FOUNDATION_MODELS_PROVIDER = 'foundation-models'
/** The one model that provider has. */
export const FOUNDATION_MODEL_ID = 'apple/on-device'

const BUNDLED_BIN = join(dirname(APP_BINARY), 'resources', 'bin')
const SIDECARS = {
  mlx: { binary: 'mlx-server', env: 'FAKE_SIDECAR_KIND=mlx' },
  // `--check` is how the core asks whether the on-device model can be used here.
  fm: { binary: 'foundation-models-server', env: 'FAKE_SIDECAR_KIND=fm' },
} as const

/** Swaps in the scripted sidecar for one bundled server; the returned function restores what was there. */
export async function installFakeSidecar(
  kind: keyof typeof SIDECARS,
  options: { reply: string; check?: 'available' | 'notEligible' | 'appleIntelligenceNotEnabled' }
): Promise<() => Promise<void>> {
  const target = join(BUNDLED_BIN, SIDECARS[kind].binary)
  // A run that was cut short leaves its launcher behind; that is not something to put back.
  const found = await readFile(target).catch(() => Buffer.alloc(0))
  const before = found.includes('fake-sidecar-server') ? Buffer.alloc(0) : found
  const script = join(CORE_REPO, 'test', 'helpers', 'fake-sidecar-server.mjs')
  await writeFile(
    target,
    [
      '#!/bin/sh',
      `export ${SIDECARS[kind].env} FAKE_FM_CHECK=${options.check ?? 'available'} FAKE_SIDECAR_MODE=ready FAKE_SIDECAR_REPLY=${JSON.stringify(options.reply)}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"`,
      '',
    ].join('\n')
  )
  await chmod(target, 0o755)
  return async () => {
    await writeFile(target, before)
    await chmod(target, 0o644)
  }
}

export const installFakeMlxServer = (options: { reply: string }) => installFakeSidecar('mlx', options)

/** An MLX model directory the app lists: a folder of weights described by `model.yml`. */
export async function writeFakeMlxModel(profile: Profile, modelId: string): Promise<void> {
  const dir = join(profile.dataFolder, 'mlx', 'models', ...modelId.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ model_type: 'llama', max_position_embeddings: 8192 }))
  await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(64, 0x4d))
  await writeFile(
    join(dir, 'model.yml'),
    [`model_path: mlx/models/${modelId}`, `name: ${modelId}`, 'size_bytes: 64', 'model_size_bytes: 64', 'embedding: false', ''].join('\n')
  )
}
