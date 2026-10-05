/**
 * Rules for the Hub's PrismML path, kept free of React so they can be tested
 * directly: which files go through the core's model setup instead of a plain
 * download, and how far a setup has come.
 */

import {
  MODEL_SETUP_FINAL_STAGES,
  type CompatibilityVerdict,
  type ModelSetup,
  type ModelSetupStage,
} from '@/services/model-setup/types'

/** The provider id of PrismML's llama.cpp. */
export const PRISM_PROVIDER = 'atomic-prism'

export type HubFile = { repo: string; file: string; revision?: string }

/**
 * `owner/repo`, file and revision of a Hugging Face download URL
 * (`https://huggingface.co/<owner>/<repo>/resolve/<revision>/<file>`), or
 * `null` for anything else — a mirror, a local path, a malformed URL.
 */
export function parseHubFileUrl(url: string): HubFile | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'huggingface.co') return null
  const parts = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)
  if (parts.length < 5 || parts[2] !== 'resolve') return null
  const [owner, name, , revision, ...file] = parts
  return { repo: `${owner}/${name}`, file: file.join('/'), revision }
}

/**
 * What the Hub does with a file the core judged:
 * - `setup`: it needs PrismML — the core installs the engine and the file in
 *   one operation (the setup sheet);
 * - `refuse`: no current engine runs it (a legacy layout, an F16 master);
 * - `download`: any llama.cpp engine runs it, or nothing is known yet — the
 *   ordinary download, with the load gate still reading the header later.
 */
export function routeForVerdict(
  verdict: CompatibilityVerdict
): 'setup' | 'refuse' | 'download' {
  switch (verdict.outcome) {
    case 'engine_required':
    case 'engine_update_required':
      return 'setup'
    case 'legacy_artifact':
    case 'unsupported':
      return 'refuse'
    case 'compatible':
      return verdict.provider === PRISM_PROVIDER ? 'setup' : 'download'
    default:
      return 'download'
  }
}

/** Whether a verdict ties the file to PrismML (the Hub's "Requires PrismML"). */
export function requiresPrism(
  verdict: CompatibilityVerdict | null | undefined
) {
  return !!verdict && routeForVerdict(verdict) === 'setup'
}

export function isFinalSetup(setup: ModelSetup): boolean {
  return MODEL_SETUP_FINAL_STAGES.includes(setup.stage)
}

/** A setup still moving on its own: neither final nor waiting for `resume`. */
export function isRunningSetup(setup: ModelSetup): boolean {
  return !isFinalSetup(setup) && setup.stage !== 'interrupted'
}

/** Keeps the record with the highest revision, as the core asks. */
export function mergeSetup(
  setups: Readonly<Record<string, ModelSetup>>,
  setup: ModelSetup
): Record<string, ModelSetup> {
  const known = setups[setup.setup_id]
  if (known && known.revision >= setup.revision) return { ...setups }
  return { ...setups, [setup.setup_id]: setup }
}

/** The newest setup of one Hub file, by when it was last written. */
export function latestSetupFor(
  setups: Iterable<ModelSetup>,
  file: HubFile
): ModelSetup | undefined {
  let latest: ModelSetup | undefined
  for (const setup of setups) {
    if (setup.request.repo !== file.repo || setup.request.file !== file.file)
      continue
    if (!latest || setup.updated_at > latest.updated_at) latest = setup
  }
  return latest
}

/** The stages a setup walks, in order; skipped ones are left out. */
export function setupSteps(setup: Pick<ModelSetup, 'plan'>): ModelSetupStage[] {
  const steps: ModelSetupStage[] = ['queued']
  if (setup.plan.engine && !setup.plan.engine.installed)
    steps.push('installing_engine')
  steps.push('downloading_model')
  if (setup.plan.projector) steps.push('downloading_projector')
  steps.push('verifying', 'registering', 'ready')
  return steps
}

export type TaskProgress = { transferred: number; total: number }

/**
 * Bytes done over bytes to do across every download of a setup. A finished
 * stage counts in full; the one running counts what its task reported.
 */
export function setupBytes(
  setup: ModelSetup,
  progress: Readonly<Record<string, TaskProgress>>
): TaskProgress {
  const { plan, task_ids: tasks } = setup
  const downloads: { stage: ModelSetupStage; size: number; task?: string }[] =
    []
  if (plan.engine && !plan.engine.installed)
    downloads.push({
      stage: 'installing_engine',
      size: plan.engine.download_size,
      task: tasks.engine,
    })
  downloads.push({
    stage: 'downloading_model',
    size: plan.model.size,
    task: tasks.model,
  })
  if (plan.projector)
    downloads.push({
      stage: 'downloading_projector',
      size: plan.projector.size,
      task: tasks.projector,
    })

  const steps = setupSteps(setup)
  const at = steps.indexOf(
    setup.stage === 'failed' ||
      setup.stage === 'cancelled' ||
      setup.stage === 'interrupted'
      ? (setup.stopped_at ?? 'queued')
      : setup.stage
  )
  let transferred = 0
  let total = 0
  for (const download of downloads) {
    const reported = download.task ? progress[download.task] : undefined
    const size = download.size || reported?.total || 0
    total += size
    const index = steps.indexOf(download.stage)
    if (at > index) transferred += size
    else if (at === index)
      transferred += Math.min(reported?.transferred ?? 0, size)
  }
  return { transferred, total }
}
