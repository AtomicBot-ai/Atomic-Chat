/**
 * The image workflows, in the order the sidebar lists them. Pure data: which
 * inputs each one takes and how the form should treat it. Icons and labels
 * live with the components (`containers/images/workflowIcons.tsx`, the
 * `images:workflow.*` keys).
 */

import type { ImageWorkflowId } from '@/services/diffusion/types'

export type ImageWorkflowSpec = {
  id: ImageWorkflowId
  /** The route that shows this workflow. */
  path: string
  /** Takes a source image (every workflow but `create`). */
  needsSource: boolean
  /** Takes a painted mask on top of the source. */
  usesMask: boolean
  /** The form's aspect / resolution control decides the output size. */
  usesResolution: boolean
  /** Has a denoise strength slider. */
  usesStrength: boolean
  /** Default denoise strength when the workflow has one. */
  defaultStrength: number | null
}

export const IMAGE_WORKFLOWS: readonly ImageWorkflowSpec[] = [
  {
    id: 'create',
    path: '/images/',
    needsSource: false,
    usesMask: false,
    usesResolution: true,
    usesStrength: false,
    defaultStrength: null,
  },
  {
    id: 'transform',
    path: '/images/transform',
    needsSource: true,
    usesMask: false,
    usesResolution: true,
    usesStrength: true,
    defaultStrength: 0.6,
  },
  {
    id: 'inpaint',
    path: '/images/inpaint',
    needsSource: true,
    usesMask: true,
    usesResolution: false,
    usesStrength: true,
    defaultStrength: 0.6,
  },
  {
    id: 'extend',
    path: '/images/extend',
    needsSource: true,
    usesMask: true,
    usesResolution: false,
    usesStrength: false,
    defaultStrength: 1,
  },
  {
    id: 'upscale',
    path: '/images/upscale',
    needsSource: true,
    usesMask: false,
    usesResolution: false,
    usesStrength: true,
    defaultStrength: 0.35,
  },
  {
    id: 'reference',
    path: '/images/reference',
    needsSource: true,
    usesMask: false,
    usesResolution: true,
    usesStrength: false,
    defaultStrength: null,
  },
  {
    id: 'edit',
    path: '/images/edit',
    needsSource: true,
    usesMask: false,
    usesResolution: false,
    usesStrength: false,
    defaultStrength: null,
  },
] as const

export const IMAGE_WORKFLOW_IDS: readonly ImageWorkflowId[] = IMAGE_WORKFLOWS.map(
  (workflow) => workflow.id
)

/** Extra references a `reference` job may carry after the source. */
export const MAX_EXTRA_REFERENCES = 3

/**
 * Ceiling for a source image read into the page. sd.cpp resizes whatever it
 * gets to the requested size, so a bigger file only costs time and memory.
 */
export const MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024

/** File extensions the dropzone and the open dialog accept. */
export const SOURCE_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const

export function isImageWorkflowId(value: unknown): value is ImageWorkflowId {
  return (
    typeof value === 'string' &&
    (IMAGE_WORKFLOW_IDS as readonly string[]).includes(value)
  )
}

export function workflowSpec(id: ImageWorkflowId): ImageWorkflowSpec {
  return IMAGE_WORKFLOWS.find((workflow) => workflow.id === id) ?? IMAGE_WORKFLOWS[0]
}

export function workflowPath(id: ImageWorkflowId): string {
  return workflowSpec(id).path
}

/** Is `path` one of the source image types we take? */
export function isSourceImagePath(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return (SOURCE_IMAGE_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * Which workflows a catalog family can run on sd.cpp. Mirrors the plugin's
 * `session::workflows_for_family`, which is what actually accepts or rejects
 * a job — the two lists must stay identical. img2img and masks are generic
 * in sd.cpp, so every image family gets them; reference-guided generation
 * and instruction edits need a model trained on reference images, and only
 * FLUX.2 Klein is.
 */
export function workflowsForFamily(family: string): ImageWorkflowId[] {
  switch (family) {
    case 'flux.2-klein':
      return ['create', 'transform', 'inpaint', 'extend', 'upscale', 'reference', 'edit']
    case 'z-image':
    case 'flux.1':
    case 'qwen-image':
      return ['create', 'transform', 'inpaint', 'extend', 'upscale']
    default:
      return ['create']
  }
}

export function familySupportsWorkflow(
  family: string,
  workflow: ImageWorkflowId
): boolean {
  return workflowsForFamily(family).includes(workflow)
}
