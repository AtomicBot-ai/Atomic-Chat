/**
 * The MLX engine where the app needs one and has none: beside the download of
 * a new MLX model, and behind a load's "Install". The install is the core's
 * (`installMlxEngine`); this decides when it starts and how its failure reads.
 */

import { toast } from 'sonner'

import i18n from '@/i18n/setup'
import { extractModelErrorMessage } from '@/lib/modelErrorMessage'
import {
  installMlxEngine,
  isMlxEngineInstallCancelled,
  mlxEngineActive,
} from '@/services/engine-builds/mlx'

/** One failure toast at a time: a retry that fails again replaces it. */
const FAILURE_TOAST_ID = 'mlx-engine-install-failed'

/**
 * Say the MLX engine did not install, with a "Retry" that runs `retry`
 * (installing again by default). Whatever the install was for stays as it is.
 */
export function reportMlxEngineInstallFailure(
  error: unknown,
  retry: () => Promise<unknown> = retryInstall
): void {
  const t = i18n.t.bind(i18n)
  toast.error(t('settings:mlxEngine.installFailed'), {
    id: FAILURE_TOAST_ID,
    description: extractModelErrorMessage(error),
    duration: 30000,
    action: {
      label: t('common:retry'),
      onClick: () => void retry(),
    },
  })
}

async function retryInstall(): Promise<void> {
  try {
    await installMlxEngine()
  } catch (error) {
    if (!isMlxEngineInstallCancelled(error))
      reportMlxEngineInstallFailure(error)
  }
}

type EngineOutcome =
  | { status: 'ready' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown }

async function installIfMissing(): Promise<EngineOutcome> {
  try {
    // `null`: the core said nothing about MLX. A load asks for the engine
    // then, so the download does not guess.
    if ((await mlxEngineActive()) !== false) return { status: 'ready' }
    await installMlxEngine()
    return { status: 'ready' }
  } catch (error) {
    return isMlxEngineInstallCancelled(error)
      ? { status: 'cancelled' }
      : { status: 'failed', error }
  }
}

/**
 * Download a new MLX model together with the engine it runs on. When MLX has
 * no active build, the engine installs beside the model (its own row in the
 * download panel), not before it. `download` brings the model in, reports its
 * own failures and resolves `true` once the model is in.
 *
 * Resolves `true` once the model is in and the engine install, if one ran,
 * has finished. An engine that failed to install is reported with a "Retry"
 * as soon as it fails, unless the model already failed; the model stays
 * downloaded either way. A cancelled install says nothing.
 */
export async function downloadWithMlxEngine(
  download: () => Promise<boolean>
): Promise<boolean> {
  let modelFailed = false
  const engine = installIfMissing().then((outcome) => {
    if (outcome.status === 'failed' && !modelFailed) {
      reportMlxEngineInstallFailure(outcome.error)
    }
    return outcome.status === 'ready'
  })
  const modelIn = await download()
  modelFailed = !modelIn
  const engineReady = await engine
  return modelIn && engineReady
}
