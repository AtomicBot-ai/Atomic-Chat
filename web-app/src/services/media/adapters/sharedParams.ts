/**
 * Shared parameter specs.
 *
 * Several adapters declare the same controls - a required multiline prompt, a
 * negative prompt, a seed, and the SD-style `steps` knob. They were each
 * inlined per adapter and had begun to drift (label, widget, ordering and
 * bounds). One canonical copy means a fix here lands everywhere at once.
 */

import type { MediaParamSpec } from '../contract'

/** The canonical prompt control: a required multiline text area. */
export const PROMPT: MediaParamSpec = {
  id: 'prompt',
  type: 'text',
  label: 'Prompt',
  group: 'core',
  order: 1,
  required: true,
  widget: 'textarea',
}

/** The canonical negative-prompt control. */
export const NEGATIVE_PROMPT: MediaParamSpec = {
  id: 'negative_prompt',
  type: 'text',
  label: 'Negative prompt',
  group: 'core',
  order: 2,
}

/**
 * The canonical seed control. `0` means "random": the job manager resolves a
 * real seed above every adapter, so a 0 is never sent on purpose.
 */
export const SEED: MediaParamSpec = {
  id: 'seed',
  type: 'seed',
  label: 'Seed',
  group: 'sampling',
  order: 9,
  min: 0,
}

/**
 * The SD-style `steps` control shared by the local engines. The default varies
 * per model, so it is a parameter rather than a constant.
 */
export function sdStepsSpec(defaultSteps: number): MediaParamSpec {
  return {
    id: 'steps',
    type: 'int',
    label: 'Steps',
    group: 'sampling',
    min: 1,
    max: 150,
    default: defaultSteps,
  }
}
