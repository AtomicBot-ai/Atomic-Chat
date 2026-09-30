import { describe, expect, it } from 'vitest'

import {
  IMAGE_WORKFLOW_IDS,
  IMAGE_WORKFLOWS,
  isImageWorkflowId,
  isSourceImagePath,
  workflowPath,
  workflowSpec,
} from '../workflows'

describe('image workflows', () => {
  it('lists the seven workflows in sidebar order, create first', () => {
    expect(IMAGE_WORKFLOW_IDS).toEqual([
      'create',
      'transform',
      'inpaint',
      'extend',
      'upscale',
      'reference',
      'edit',
    ])
  })

  it('maps create to the index route and the rest to their own path', () => {
    expect(workflowPath('create')).toBe('/images/')
    expect(workflowPath('inpaint')).toBe('/images/inpaint')
    for (const workflow of IMAGE_WORKFLOWS) {
      expect(workflow.path.startsWith('/images/')).toBe(true)
    }
  })

  it('only create needs no source, and only the mask workflows need a mask', () => {
    expect(workflowSpec('create').needsSource).toBe(false)
    expect(IMAGE_WORKFLOWS.filter((w) => w.needsSource).length).toBe(6)
    expect(IMAGE_WORKFLOWS.filter((w) => w.usesMask).map((w) => w.id)).toEqual([
      'inpaint',
      'extend',
    ])
    // Size comes from the source for these; the form hides its size control.
    expect(IMAGE_WORKFLOWS.filter((w) => !w.usesResolution).map((w) => w.id)).toEqual([
      'inpaint',
      'extend',
      'upscale',
      'edit',
    ])
  })

  it('recognises workflow ids and image paths', () => {
    expect(isImageWorkflowId('upscale')).toBe(true)
    expect(isImageWorkflowId('video')).toBe(false)
    expect(isImageWorkflowId(3)).toBe(false)
    expect(isSourceImagePath('/a/b/photo.JPG')).toBe(true)
    expect(isSourceImagePath('C:\\pics\\x.webp')).toBe(true)
    expect(isSourceImagePath('/a/b/notes.txt')).toBe(false)
  })
})

describe('workflowsForFamily', () => {
  // Must match `session::workflows_for_family` in the diffusion plugin: the
  // plugin is what accepts or rejects the job.
  it('matches the workflows supported by each image architecture', async () => {
    const { familySupportsWorkflow, workflowsForFamily } = await import('../workflows')
    for (const family of ['z-image', 'flux.1', 'qwen-image']) {
      expect(workflowsForFamily(family)).toEqual([
        'create',
        'transform',
        'inpaint',
        'extend',
        'upscale',
      ])
    }
    expect(workflowsForFamily('flux.2-klein')).toHaveLength(7)
    expect(familySupportsWorkflow('flux.2-klein', 'edit')).toBe(true)
    expect(workflowsForFamily('qwen-image-2.1')).toEqual([
      'create',
      'reference',
      'edit',
    ])
    expect(familySupportsWorkflow('qwen-image-2.1', 'edit')).toBe(true)
    expect(familySupportsWorkflow('qwen-image-2.1', 'transform')).toBe(false)
    expect(workflowsForFamily('krea-2-turbo')).toEqual(['create'])
    expect(familySupportsWorkflow('krea-2-turbo', 'transform')).toBe(false)
    expect(familySupportsWorkflow('z-image', 'edit')).toBe(false)
    expect(workflowsForFamily('wan2.2-ti2v-5b')).toEqual(['create'])
  })
})
