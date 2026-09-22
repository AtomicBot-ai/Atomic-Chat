/**
 * The image engine a scenario gets instead of stable-diffusion.cpp: the core's own scripted
 * `sd-server`, installed the way the app's installer would have left it.
 *
 * It cannot go through the sidecar override the MLX and Foundation Models fakes use
 * (`bundled-sidecars.ts`): the diffusion engine is never bundled with the app, and the core finds
 * it through the install record under the data folder rather than in the binaries directory. So the
 * tree is written where an install would have written it — launchers, ownership marker and record —
 * and the core then lists, finalises and spawns it as it would any engine the user installed.
 */
import { PLATFORM } from './platform.js'
import { coreHelper } from './fixtures.js'
import type { Profile } from './profile.js'

/**
 * The release the app's bundled manifest snapshot names. It matters: the app refuses to load the
 * newer model families on an older engine, so a fake installed under the core helper's own default
 * would fail a scenario for a reason that has nothing to do with what it tests.
 */
export const FAKE_SD_TAG = 'master-883-137f740'
/** What the backend matrix picks for Apple silicon, which is where this suite runs. */
export const FAKE_SD_BACKEND_ID = 'macos-arm64'
/** The launchers are `#!/bin/sh` scripts, as everywhere else in this harness. */
export const CAN_RUN_FAKE_SD = PLATFORM !== 'win32'

export interface FakeDiffusionOptions {
  /** How the engine behaves: ready by default, or one of the ways sd.cpp fails. */
  mode?: 'ready' | 'hang' | 'exit-early' | 'foreign' | 'queue-full' | 'fail-job' | 'die-mid-job' | 'ggml-abort'
  /** Milliseconds before the port is bound — the window in which a load can be observed. */
  loadMs?: number
  /** Milliseconds per sampling step; a step slow enough to catch progress on screen. */
  stepMs?: number
  /** Advertise and honour a cancel while generating. */
  cancel?: boolean
  exitCode?: number
  stderr?: string
  /** Where the fake writes the argv and host switches it was started with. */
  argvFile?: string
  envFile?: string
  pidFile?: string
  tag?: string
  backendId?: string
}

interface CoreDiffusionHelpers {
  installFakeSdEngine: (
    layout: unknown,
    options: Record<string, unknown>
  ) => Promise<{ dir: string; tag: string; backendId: string }>
  writeFakeSdModel: (layout: unknown, name?: string) => Promise<string>
}

async function helpers(): Promise<CoreDiffusionHelpers> {
  try {
    return await coreHelper<CoreDiffusionHelpers>('test/helpers/fake-sd-server.ts')
  } catch (cause) {
    throw new Error(
      'the atomic-chat-core checkout has no fake sd-server; it predates the diffusion runtime. ' +
        'Update the checkout beside this repository, or point ATOMIC_CORE_REPO at one that has it.',
      { cause }
    )
  }
}

/** An installed image engine whose binaries are the fake, as the core will find it. */
export async function installFakeDiffusionEngine(
  profile: Profile,
  options: FakeDiffusionOptions = {}
): Promise<{ dir: string; tag: string; backendId: string }> {
  const config = await coreHelper<{ dataLayout: (root: string) => unknown }>('src/config/index.ts')
  const sd = await helpers()
  return sd.installFakeSdEngine(config.dataLayout(profile.dataFolder), {
    tag: FAKE_SD_TAG,
    backendId: FAKE_SD_BACKEND_ID,
    // Apple silicon installs the Metal build; the record is what the app reads back and shows.
    backend: 'metal',
    ...options,
  })
}

/** Weights for the engine to be pointed at. Nothing reads them: the fake paints its own image. */
export async function writeFakeDiffusionModel(
  profile: Profile,
  name = 'z-image/z-image-turbo-Q4_K_M.gguf'
): Promise<string> {
  const config = await coreHelper<{ dataLayout: (root: string) => unknown }>('src/config/index.ts')
  const sd = await helpers()
  return sd.writeFakeSdModel(config.dataLayout(profile.dataFolder), name)
}
