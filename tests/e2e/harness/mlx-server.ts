/**
 * MLX without MLX. The core starts `mlx-server` from the app's bundled binaries
 * folder, which for the e2e build is part of the build output and holds an
 * empty placeholder. A scenario swaps the placeholder for a launcher of the
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
const BUNDLED_MLX_SERVER = join(dirname(APP_BINARY), 'resources', 'bin', 'mlx-server')

/** Swaps in the scripted `mlx-server`; the returned function restores what was there. */
export async function installFakeMlxServer(options: { reply: string }): Promise<() => Promise<void>> {
  // A run that was cut short leaves its launcher behind; that is not something to put back.
  const found = await readFile(BUNDLED_MLX_SERVER).catch(() => Buffer.alloc(0))
  const before = found.includes('fake-sidecar-server') ? Buffer.alloc(0) : found
  const script = join(CORE_REPO, 'test', 'helpers', 'fake-sidecar-server.mjs')
  await writeFile(
    BUNDLED_MLX_SERVER,
    [
      '#!/bin/sh',
      `export FAKE_SIDECAR_KIND=mlx FAKE_SIDECAR_MODE=ready FAKE_SIDECAR_REPLY=${JSON.stringify(options.reply)}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"`,
      '',
    ].join('\n')
  )
  await chmod(BUNDLED_MLX_SERVER, 0o755)
  return async () => {
    await writeFile(BUNDLED_MLX_SERVER, before)
    await chmod(BUNDLED_MLX_SERVER, 0o644)
  }
}

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
