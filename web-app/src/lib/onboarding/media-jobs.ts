import type { OnboardingJob } from '@/lib/onboarding/jobs'

/**
 * Runs one image or video job of a first run: installs the image engine when
 * it is missing, then downloads the job's model file (`artifactId`).
 * Resolves `true` once the file is in place, `false` when it failed or was
 * cancelled. `OnboardingRuntime` calls it for jobs of kind image and video,
 * one at a time, after the chat model.
 *
 * Not wired yet: the media step that queues these jobs does not exist.
 */
export async function startMediaJob(job: OnboardingJob): Promise<boolean> {
  console.warn('[onboarding] media jobs are not wired yet', job.key)
  return false
}
