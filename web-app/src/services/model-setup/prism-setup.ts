/**
 * A Bonsai download, run by the app. The core no longer sets models up
 * (atomic-chat-core 0.17.0): the app plans from what the core reports, has the
 * core install and activate the PrismML build the file needs, downloads the
 * model with its own downloader under `atomic-prism`, and asks the core about
 * the file on disk before keeping it.
 */

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { deleteLocalModel } from '@/lib/model-deletion'
import { planPrismSetup, PRISM_PROVIDER } from '@/lib/model-setup'
import type { ServiceHub } from '@/services'
import { sanitizeTaskId } from '@/services/diffusion/transfer'
import { getDownloadFreeSpace } from '@/services/models/downloadPreflight'
import {
  ENGINE_BUILD_TASK_PREFIX,
  followCoreDownload,
} from '@/services/engine-builds/install'

import type {
  CompatibilityVerdict,
  ModelSetupService,
  PrismPack,
  PrismSetupPlan,
  PrismSetupRequest,
} from './types'

/**
 * The plan for one file, from what the core knows now: its verdict (the conf
 * rules and the file's remote header, as the core's own setup read it), the
 * Bonsai families, the PrismML catalog and the free space. Asked afresh every
 * time, so a plan is never older than the sheet that shows it.
 */
export async function loadPrismSetupPlan(
  service: ModelSetupService,
  request: PrismSetupRequest
): Promise<PrismSetupPlan> {
  const [verdict, families, catalog, freeBytes, space] = await Promise.all([
    service.checkCompatibility({
      repo: request.repo,
      file: request.file,
      ...(request.revision ? { revision: request.revision } : {}),
      inspect_remote: true,
    }),
    service.families(),
    service.prismCatalog(),
    service.diskAvailable().catch(() => null),
    getDownloadFreeSpace(),
  ])
  return planPrismSetup({
    request,
    verdict,
    families: families.families,
    catalog,
    freeBytes,
    headroomBytes: space?.headroom ?? 0,
  })
}

/** The download panel's row id of a PrismML build install, cancelled through the core. */
export function prismBuildTaskId(pack: PrismPack): string {
  return `${ENGINE_BUILD_TASK_PREFIX}${PRISM_PROVIDER}-${sanitizeTaskId(pack.version)}`
}

/** How a model download ended, as far as the setup is concerned. */
export type PrismPullResult = 'done' | 'paused' | 'refused'

/** What a setup does in the world; tests replace each. */
export type PrismSetupDeps = {
  installBuild: (pack: PrismPack, taskId: string) => Promise<unknown>
  activateBuild: (pack: PrismPack) => Promise<unknown>
  /** Download the model (and projector) of `plan` under `atomic-prism`. */
  pull: (plan: PrismSetupPlan) => Promise<PrismPullResult>
  /** The core's verdict on the registered model, read from its file on disk. */
  check: (modelId: string) => Promise<CompatibilityVerdict>
  remove: (modelId: string) => Promise<unknown>
}

export type PrismSetupStage =
  | 'installing_engine'
  | 'activating_engine'
  | 'downloading'
  | 'verifying'

export type PrismSetupOutcome =
  | { outcome: 'ready' }
  /** The download stopped before it finished: a pause, or no room on the drive. */
  | { outcome: 'paused' }
  | { outcome: 'refused' }
  /** The file on disk is not one PrismML runs; it was removed. */
  | { outcome: 'rejected'; reason: string }
  /**
   * The core could not be asked about the file (restarting, unreachable). The
   * model stays: the load gate reads its header before it ever runs.
   */
  | { outcome: 'unchecked' }

/**
 * Keep a downloaded model only if PrismML runs the file now on disk: the
 * core reads its header (`POST /models/compatibility` by `model_id`), and a
 * verdict other than `compatible` removes the model again.
 */
export async function verifyPrismDownload(
  modelId: string,
  deps: Pick<PrismSetupDeps, 'check' | 'remove'>
): Promise<PrismSetupOutcome> {
  let verdict: CompatibilityVerdict
  try {
    verdict = await deps.check(modelId)
  } catch (error) {
    console.warn(`[prism-setup] could not check ${modelId} on disk:`, error)
    return { outcome: 'unchecked' }
  }
  if (verdict.outcome === 'compatible') return { outcome: 'ready' }
  await deps.remove(modelId)
  return { outcome: 'rejected', reason: verdict.reason }
}

/**
 * Run a plan: install the build when it is not on disk, make it active when
 * the file does not run on the current one, then download the model and check
 * it. A refused install (`ENGINE_INSTALL_IN_PROGRESS`, a build the manifest no
 * longer offers) rejects with the core's error before anything is downloaded.
 */
export async function runPrismSetup(
  plan: PrismSetupPlan,
  deps: PrismSetupDeps,
  onStage?: (stage: PrismSetupStage) => void
): Promise<PrismSetupOutcome> {
  const { engine } = plan
  if (engine && !engine.installed) {
    onStage?.('installing_engine')
    await deps.installBuild(engine, prismBuildTaskId(engine))
  }
  if (engine && plan.verdict.outcome !== 'compatible') {
    onStage?.('activating_engine')
    await deps.activateBuild(engine)
  }
  onStage?.('downloading')
  const pulled = await deps.pull(plan)
  if (pulled !== 'done') return { outcome: pulled }
  onStage?.('verifying')
  return verifyPrismDownload(plan.model_id, deps)
}

/**
 * The setup's dependencies in the app: the build installs with its row in the
 * download panel (cancelled through the core like any engine build), the
 * model downloads with the app's own downloader under `atomic-prism` with the
 * families' hashes and sizes, and a rejected model is deleted like one the
 * user deleted.
 */
export function prismSetupDeps(
  serviceHub: ServiceHub,
  options: {
    hfToken?: string
    resume?: boolean
    /** The build's bytes as they arrive, for the Hub row. */
    onEngineProgress?: (progress: { transferred: number; total: number }) => void
  } = {}
): PrismSetupDeps {
  const service = serviceHub.modelSetup()
  return {
    installBuild: (pack, taskId) =>
      followCoreDownload(
        taskId,
        () => service.installPrismBuild(pack, taskId),
        options.onEngineProgress
      ),
    activateBuild: (pack) => service.activatePrismBuild(pack),
    pull: async (plan) => {
      const refusal = await serviceHub.models().pullModelWithMetadata(
        plan.model_id,
        plan.model.url,
        plan.projector?.url,
        options.hfToken,
        true,
        options.resume ?? false,
        prismPullOptions(plan)
      )
      if (refusal) return 'refused'
      // A pause resolves the pull too, with the partial file kept.
      return useDownloadStore.getState().pausedDownloads.has(plan.model_id)
        ? 'paused'
        : 'done'
    },
    check: (modelId) =>
      service.checkCompatibility({ model_id: modelId, provider: PRISM_PROVIDER }),
    remove: (modelId) => deleteLocalModel(serviceHub, modelId, PRISM_PROVIDER),
  }
}

/** The provider and the families' hashes and sizes a Bonsai pull is given. */
export function prismPullOptions(plan: PrismSetupPlan) {
  return {
    provider: PRISM_PROVIDER,
    ...(plan.model.sha256 ? { modelSha256: plan.model.sha256 } : {}),
    ...(plan.model.size ? { modelSize: plan.model.size } : {}),
    ...(plan.projector?.sha256 ? { mmprojSha256: plan.projector.sha256 } : {}),
    ...(plan.projector?.size ? { mmprojSize: plan.projector.size } : {}),
  }
}
