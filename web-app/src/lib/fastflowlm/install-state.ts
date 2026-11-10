export type FastFlowLmInstallState =
  | 'downloading'
  | 'publishing'
  | 'accepted'
  | 'rollback-pending'
  | 'rolled-back'
  | 'ready'

/** Old rollback journals need their original maintenance guard reconciled once. */
export function isFastFlowLmInstallFinished(job: {
  state: FastFlowLmInstallState
  maintenance_completed?: boolean
}): boolean {
  return (
    job.state === 'ready' ||
    (job.state === 'rolled-back' && job.maintenance_completed === true)
  )
}
