/**
 * Task 11 Step 2 - the behaviour the Media Studio does NOT have yet.
 *
 * Everything here is red until Steps 4-7 land, and each test names the thing
 * the current surface cannot do:
 *
 *  - Tabs come from what the providers actually declare, not from a hardcoded
 *    MODES list. That list is coupling C3: it omits image_to_image outright, so
 *    a model offering it has no way to be reached however it is configured.
 *  - A provider selector exists at all, because there can now be more than one.
 *  - Submitting routes to the provider that owns the chosen model, rather than
 *    always to the bundled worker.
 *  - Cancel appears only when the provider says it can cancel, instead of the
 *    v1 no-op that cleared a local timer and never told the worker (C11).
 *
 * Fixtures are v2 capabilities built here rather than upcast from v1: the point
 * is to prove the surface is driven by the contract, and a v1-shaped fixture
 * could only ever exercise what v1 happens to express.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MediaGenerationForm } from '../MediaGenerationForm'
import { MediaJobStatus } from '../MediaJobStatus'
import { MEDIA_TASK } from '@/services/media/contract'
import type {
  MediaCapabilities,
  MediaJobSnapshot,
  MediaModelDescriptor,
  MediaParamSpec,
  MediaProviderDescriptor,
  MediaTaskPresentation,
  NormalizedMediaRequest,
} from '@/services/media/contract'

const PROMPT_SPEC: MediaParamSpec = {
  id: 'prompt',
  type: 'text',
  group: 'core',
  label: 'Prompt',
  required: true,
  order: 0,
}

const STEPS_SPEC: MediaParamSpec = {
  id: 'steps',
  type: 'int',
  group: 'sampling',
  label: 'Steps',
  min: 1,
  max: 50,
  default: 20,
  order: 1,
}

function modelFor(
  providerId: string,
  localId: string,
  tasks: string[]
): MediaModelDescriptor {
  return {
    id: `${providerId}:${localId}`,
    provider_id: providerId,
    local_id: localId,
    label: `${localId} on ${providerId}`,
    tasks,
    params: Object.fromEntries(
      tasks.map((task) => [task, [PROMPT_SPEC, STEPS_SPEC]])
    ),
  }
}

function providerFor(id: string, label: string): MediaProviderDescriptor {
  return {
    id,
    label,
    kind: 'local_worker',
    adapter: 'atomic-media-worker',
    enabled: true,
    origin: 'builtin',
  }
}

const TASKS: MediaTaskPresentation[] = [
  { id: MEDIA_TASK.TEXT_TO_IMAGE, label: 'Text → Image', output_media_type: 'image', order: 0 },
  { id: MEDIA_TASK.IMAGE_TO_IMAGE, label: 'Image → Image', output_media_type: 'image', order: 1 },
  { id: MEDIA_TASK.TEXT_TO_VIDEO, label: 'Text → Video', output_media_type: 'video', order: 2 },
]

const ALPHA = providerFor('alpha', 'Alpha Worker')
const BETA = providerFor('beta', 'Beta Cloud')

type FormOverrides = {
  tasks?: MediaTaskPresentation[]
  task?: string
  models?: MediaModelDescriptor[]
  providers?: MediaProviderDescriptor[]
  selectedModelId?: string | null
  onSubmit?: (request: NormalizedMediaRequest) => void
  onTaskChange?: (task: string) => void
  onSelectModel?: (id: string) => void
}

function renderForm(overrides: FormOverrides = {}) {
  const onSubmit = overrides.onSubmit ?? vi.fn()
  const onTaskChange = overrides.onTaskChange ?? vi.fn()
  const onSelectModel = overrides.onSelectModel ?? vi.fn()
  const models = overrides.models ?? [
    modelFor('alpha', 'sdxl', [MEDIA_TASK.TEXT_TO_IMAGE]),
  ]

  const result = render(
    <MediaGenerationForm
      tasks={overrides.tasks ?? TASKS}
      task={overrides.task ?? MEDIA_TASK.TEXT_TO_IMAGE}
      onTaskChange={onTaskChange}
      models={models}
      providers={overrides.providers ?? [ALPHA, BETA]}
      devices={[]}
      selectedModelId={
        overrides.selectedModelId === undefined
          ? (models[0]?.id ?? null)
          : overrides.selectedModelId
      }
      onSelectModel={onSelectModel}
      onSubmit={onSubmit}
    />
  )

  return { ...result, onSubmit, onTaskChange, onSelectModel }
}

/** Fill the prompt and press Generate. */
function generate(prompt = 'a cat in a hat') {
  fireEvent.change(screen.getByLabelText('Prompt'), {
    target: { value: prompt },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
}

describe('tabs come from the providers, not from a hardcoded list', () => {
  it('renders one tab per declared task, in the declared order', () => {
    renderForm()

    const tabs = screen
      .getAllByRole('tab')
      .map((node) => node.textContent?.trim())

    expect(tabs).toEqual(['Text → Image', 'Image → Image', 'Text → Video'])
  })

  it('offers image_to_image, which the hardcoded MODES list omitted (C3)', () => {
    renderForm()

    expect(
      screen.getByRole('tab', { name: 'Image → Image' })
    ).toBeInTheDocument()
  })

  it('renders a task this build has never heard of rather than dropping it', () => {
    renderForm({
      tasks: [
        ...TASKS,
        { id: 'text_to_hologram', output_media_type: 'unknown', order: 3 },
      ],
    })

    // No label and no i18n key, so the id itself is the honest fallback.
    expect(
      screen.getByRole('tab', { name: 'text_to_hologram' })
    ).toBeInTheDocument()
  })

  it('marks the current task selected, and reports a change rather than holding it privately', () => {
    const { onTaskChange } = renderForm()

    // The task is owned by the caller, so the tab strip must SHOW the one it
    // was given and ASK for any other, never switch on its own.
    expect(
      screen.getByRole('tab', { name: 'Text → Image' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('tab', { name: 'Text → Video' })
    ).toHaveAttribute('aria-selected', 'false')

    fireEvent.click(screen.getByRole('tab', { name: 'Text → Video' }))

    expect(onTaskChange).toHaveBeenCalledWith(MEDIA_TASK.TEXT_TO_VIDEO)
    expect(onTaskChange).toHaveBeenCalledTimes(1)
    // Still showing the caller's task: it did not move on its own.
    expect(
      screen.getByRole('tab', { name: 'Text → Image' })
    ).toHaveAttribute('aria-selected', 'true')
  })
})

describe('the provider selector', () => {
  const twoProviders = [
    modelFor('alpha', 'sdxl', [MEDIA_TASK.TEXT_TO_IMAGE]),
    modelFor('beta', 'flux', [MEDIA_TASK.TEXT_TO_IMAGE]),
  ]

  it('lists every provider offering a model for this task', () => {
    const { container } = renderForm({ models: twoProviders })

    const options = within(screen.getByLabelText('Provider'))
      .getAllByRole('option')
      .map((node) => node.textContent)

    expect(options).toEqual(['Alpha Worker', 'Beta Cloud'])
    expect(container.querySelector('#media-provider')).toBeInTheDocument()
  })

  it('omits a provider with no model for the current task', () => {
    renderForm({
      models: [modelFor('alpha', 'sdxl', [MEDIA_TASK.TEXT_TO_IMAGE])],
    })

    const options = within(screen.getByLabelText('Provider'))
      .getAllByRole('option')
      .map((node) => node.textContent)

    expect(options).toEqual(['Alpha Worker'])
  })

  it('narrows the model list to the chosen provider', () => {
    renderForm({ models: twoProviders, selectedModelId: 'alpha:sdxl' })

    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'beta' },
    })

    fireEvent.click(screen.getByLabelText('Model'))
    const models = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((node) => node.getAttribute('aria-label'))

    expect(models).toEqual(['flux on beta'])
  })

  it('shows which provider a model belongs to before it is chosen', () => {
    renderForm({ models: twoProviders })

    // Two providers may both expose "sdxl"; the label alone is ambiguous.
    expect(screen.getByLabelText('Provider')).toHaveValue('alpha')
  })
})

describe('cross-provider routing', () => {
  const twoProviders = [
    modelFor('alpha', 'sdxl', [MEDIA_TASK.TEXT_TO_IMAGE]),
    modelFor('beta', 'flux', [MEDIA_TASK.TEXT_TO_IMAGE]),
  ]

  it('submits against the provider that owns the chosen model', () => {
    const onSubmit = vi.fn()
    renderForm({
      models: twoProviders,
      selectedModelId: 'beta:flux',
      onSubmit,
    })

    generate()

    const request = onSubmit.mock.calls[0]?.[0] as NormalizedMediaRequest
    expect(request.provider_id).toBe('beta')
    expect(request.model_id).toBe('beta:flux')
    expect(request.task).toBe(MEDIA_TASK.TEXT_TO_IMAGE)
  })

  it('never sends the bare local id, which two providers may share', () => {
    const onSubmit = vi.fn()
    renderForm({
      models: twoProviders,
      selectedModelId: 'beta:flux',
      onSubmit,
    })

    generate()

    const request = onSubmit.mock.calls[0]?.[0] as NormalizedMediaRequest
    expect(request.model_id).not.toBe('flux')
    expect(request.model_id.startsWith(`${request.provider_id}:`)).toBe(true)
  })

  it('carries a client job id so the submit is idempotent', () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit })

    generate()

    const request = onSubmit.mock.calls[0]?.[0] as NormalizedMediaRequest
    expect(typeof request.client_job_id).toBe('string')
    expect(request.client_job_id.length).toBeGreaterThan(0)
  })

  it('submits the schema values, validated, alongside the prompt', () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit })

    generate('a cat in a hat')

    const request = onSubmit.mock.calls[0]?.[0] as NormalizedMediaRequest
    expect(request.params).toEqual({
      prompt: 'a cat in a hat',
      steps: 20,
    })
  })

  it('refuses to submit without a prompt, which the schema marks required', () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit })

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
  })
})

describe('cancel is gated on what the provider can actually do', () => {
  function job(overrides: Partial<MediaJobSnapshot> = {}): MediaJobSnapshot {
    return {
      client_job_id: 'job-1',
      provider_id: 'alpha',
      state: 'running',
      progress: 40,
      ...overrides,
    }
  }

  function renderStatus(
    overrides: {
      cancellable?: boolean
      onCancel?: () => void
      snapshot?: MediaJobSnapshot
    } = {}
  ) {
    const onCancel = overrides.onCancel ?? vi.fn()
    const result = render(
      <MediaJobStatus
        job={overrides.snapshot ?? job()}
        cancellable={overrides.cancellable ?? false}
        onCancel={onCancel}
        providers={[ALPHA, BETA]}
        health={{ alpha: { state: 'online' }, beta: { state: 'offline' } }}
        errors={{}}
        onRetryProvider={vi.fn()}
      />
    )
    return { ...result, onCancel }
  }

  it('offers Cancel when the provider reports it can cancel', () => {
    renderStatus({ cancellable: true })

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('does not offer Cancel when the provider cannot', () => {
    renderStatus({ cancellable: false })

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('does not offer Cancel once the job has finished', () => {
    renderStatus({
      cancellable: true,
      snapshot: job({ state: 'succeeded', progress: 100 }),
    })

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('asks the caller to cancel the job it is actually showing', () => {
    const { onCancel } = renderStatus({ cancellable: true })

    // Tie the argument to what is on screen: cancelling a different job than
    // the one displayed is the failure this guards against.
    expect(screen.getByText('Job job-1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledWith('job-1')
  })

  it('reports each provider health separately, not one global worker state', () => {
    renderStatus()

    expect(screen.getByText(/Alpha Worker/)).toBeInTheDocument()
    expect(screen.getByText(/Beta Cloud/)).toBeInTheDocument()
  })
})
