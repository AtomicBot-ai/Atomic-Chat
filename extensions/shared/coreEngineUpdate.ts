/**
 * A llama.cpp engine update the core applies (`POST /engines/:engine/update`, openspec change
 * `unify-engine-lifecycle`), started by an extension on its own: a TurboQuant first-run adoption,
 * a parked `latest/<variant>` the upstream extension resolves. The core installs the build,
 * switches `version_backend` and unloads the provider's models; the extension writes no version,
 * stops no model and removes no build itself.
 *
 * The desktop keeps hearing what it always did: the backend download start and finish
 * (`AppEvent.onBackendDownloadStarted/Finished`), the download panel's progress under the task id
 * and, once the provider runs from the new build, `app:backend-hotswapped`. The task id carries the
 * `engine-update-` prefix the panel's Cancel routes to the core's `POST /downloads/:id/cancel`.
 *
 * No imports beyond the shared runtime's types: each extension bundles this file and passes in its
 * own `listen`, event bus and `window.dispatchEvent`.
 */

import type { CoreEngineUpdateRequest, CoreEngineUpdateResult } from './atomicCoreRuntime'
import { describeCoreError } from './atomicCoreRuntime'

/** `engine-update-<provider>-<what>`, in Tauri's event-name alphabet. */
export function engineUpdateTaskId(provider: string, what: string): string {
  return `engine-update-${provider}-${what.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

type Unlisten = () => void

export interface UpdateEngineThroughCoreOptions {
  core: { updateEngine(request: CoreEngineUpdateRequest): Promise<CoreEngineUpdateResult> }
  provider: string
  /** What the backend dialog knows this switch by: `<version>/<variant>` or `latest/<variant>`. */
  backend: string
  target: { version?: string; variant: string }
  proxy: CoreEngineUpdateRequest['proxy']
  listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<Unlisten>
  emit: (name: string, payload: unknown) => void
  dispatch: (event: CustomEvent) => void
}

type ProgressFrame = {
  transferred: number
  total: number
  stage?: { kind: string; attempt: number; maxAttempts: number }
}

export async function updateEngineThroughCore(
  options: UpdateEngineThroughCoreOptions
): Promise<CoreEngineUpdateResult> {
  const { provider, backend, emit } = options
  const [version, backendId] = backend.split('/')
  const taskId = engineUpdateTaskId(provider, backend)

  let transferred = 0
  let total = 0
  let reported = false
  const report = (bytes: number, size: number) => {
    reported = true
    // A resumed transfer can restart at byte zero; the bar never moves backwards.
    transferred = Math.max(transferred, bytes)
    total = Math.max(total, size)
    const shown = total > 0 ? Math.max(total, transferred) : 0
    emit('onFileDownloadUpdate', {
      modelId: taskId,
      percent: shown > 0 ? transferred / shown : 0,
      size: { transferred, total: shown },
      downloadType: 'Backend',
    })
  }
  // Registered before the call: the core reports progress before it answers.
  const unlisten = await options.listen(`download-${taskId}`, (event) => {
    const frame = event.payload as ProgressFrame
    if (frame.stage) {
      if (!reported) report(0, 0)
      emit('onFileDownloadUpdate', { modelId: taskId, downloadType: 'Backend', stage: frame.stage })
      return
    }
    report(frame.transferred, frame.total)
  })
  const finished = (status: 'completed' | 'failed', error?: string) =>
    emit('onBackendDownloadFinished', {
      backend,
      status,
      ...(error ? { error } : {}),
      provider,
      version,
      backendId,
    })

  emit('onBackendDownloadStarted', {
    backend,
    status: 'downloading',
    provider,
    version,
    backendId,
  })
  let result: CoreEngineUpdateResult
  try {
    result = await options.core.updateEngine({
      task_id: taskId,
      target: options.target,
      ...(options.proxy ? { proxy: options.proxy } : {}),
    })
  } catch (error) {
    const message = describeCoreError(error)
    emit('onFileDownloadError', { modelId: taskId, error: message, downloadType: 'Backend' })
    finished('failed', message)
    throw error
  } finally {
    unlisten()
  }
  if (reported) {
    emit('onFileDownloadAndVerificationSuccess', { modelId: taskId, downloadType: 'Backend' })
  }
  finished('completed')
  if (result.active) {
    const { version: activeVersion, variant } = result.active
    options.dispatch(
      new CustomEvent('app:backend-hotswapped', {
        detail: {
          backend: `${activeVersion}/${variant}`,
          provider,
          version: activeVersion,
          backendId: variant,
        },
      })
    )
  }
  return result
}
