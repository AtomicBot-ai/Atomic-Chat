/**
 * MLX without MLX, and Apple's on-device model without Apple Intelligence. The
 * core starts `mlx-server` and `foundation-models-server` from the app's bundled
 * binaries folder — or, in an e2e build, from `<root>/sidecars` when the run has
 * one. A scenario puts a launcher of the core's scripted sidecar there, so the
 * stand-in lives and dies with its profile, and scenarios running beside it
 * never see it.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CORE_REPO } from './fixtures.js'
import type { Profile } from './profile.js'

export const MLX_PROVIDER = 'mlx'
export const FOUNDATION_MODELS_PROVIDER = 'foundation-models'
/** The one model that provider has. */
export const FOUNDATION_MODEL_ID = 'apple/on-device'

const SIDECARS = {
  mlx: { binary: 'mlx-server', env: 'FAKE_SIDECAR_KIND=mlx' },
  // `--check` is how the core asks whether the on-device model can be used here.
  fm: { binary: 'foundation-models-server', env: 'FAKE_SIDECAR_KIND=fm' },
} as const

/** Stands the scripted sidecar in for one bundled server, for this profile only. Call it from `prepare`. */
export async function installFakeSidecar(
  profile: Profile,
  kind: keyof typeof SIDECARS,
  options: { reply: string; check?: 'available' | 'notEligible' | 'appleIntelligenceNotEnabled' }
): Promise<void> {
  const dir = join(profile.root, 'sidecars')
  await mkdir(dir, { recursive: true })
  const target = join(dir, SIDECARS[kind].binary)
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
