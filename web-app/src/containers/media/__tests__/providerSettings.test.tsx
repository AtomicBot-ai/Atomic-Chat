/**
 * Task 12 Step 1 - the provider and model management UI that does not exist yet.
 *
 * Everything here is red until Steps 3-5 land. Each test names a capability the
 * settings surface has to have, taken from the plan's Step 1 list:
 *
 *  - a custom provider can be added at all, which is the whole point of Task 4
 *    having made providers a list rather than one hardcoded worker;
 *  - a provider pointed at a bad URL surfaces its own error WITHOUT taking the
 *    others down with it - the store already isolates per provider, and this is
 *    the test that the UI does not undo that isolation by rendering one shared
 *    error state;
 *  - enabling a provider makes its models reachable in the studio, which is the
 *    only reason the settings screen exists;
 *  - install progress renders, and an install FAILURE is recoverable rather
 *    than a dead end (C9);
 *  - an API key is masked and never reaches the DOM or the store in plaintext.
 *
 * The transport is the only thing stubbed. `createMediaAdapter` is the seam the
 * store already uses, so stubbing it exercises the real store, the real
 * descriptors and the real components - not a parallel implementation.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MediaGenerationForm } from '../MediaGenerationForm'
import { ModelCatalog } from '../ModelCatalog'
import { ProviderList } from '../ProviderList'
import { MEDIA_TASK } from '@/services/media/contract'
import type {
  MediaCapabilities,
  MediaModelDescriptor,
  MediaProviderAdapter,
  MediaProviderDescriptor,
  MediaProviderHealth,
  MediaTaskPresentation,
} from '@/services/media/contract'
import { getMediaProviderSecret } from '@/services/media/secrets'
import { clearMediaRegistryCache } from '@/services/media-registry'
import { useMediaProviderStore } from '@/stores/media-provider-store'

// The default translation context returns the raw KEY and ignores
// `defaultValue`, so a component rendered without a TranslationProvider shows
// literal keys. Rather than change that shared default - five unrelated tests
// deliberately assert on raw keys - this file delegates to the REAL i18n
// instance. The assertions below therefore check the English a user actually
// sees, and prove every `media:` key resolves. Recorded as decision D18.
vi.mock('@/i18n/react-i18next-compat', async () => {
  const setup = await vi.importActual<{
    default: { t: (k: string, o?: Record<string, unknown>) => string }
  }>('@/i18n/setup')
  return {
    useTranslation: () => ({ t: setup.default.t, i18n: setup.default }),
  }
})

const { mockAdapters } = vi.hoisted(() => ({
  mockAdapters: new Map<string, Partial<MediaProviderAdapter>>(),
}))

const { mockSecrets } = vi.hoisted(() => ({
  mockSecrets: new Map<string, string>(),
}))

// The credential store lives in Rust now (Task 18). Stubbing the IPC boundary
// keeps these tests exercising the real secrets module and the real component,
// while guaranteeing the suite never touches a developer's actual keychain.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    const key = args?.key as string
    if (command === 'media_secret_set') {
      mockSecrets.set(key, args.secret as string)
      return undefined
    }
    if (command === 'media_secret_get') return mockSecrets.get(key) ?? null
    if (command === 'media_secret_delete') {
      mockSecrets.delete(key)
      return undefined
    }
    if (command === 'media_secret_available') return true
    throw new Error(`unexpected command ${command}`)
  },
}))

vi.mock('@/services/media/providerFactory', () => ({
  createMediaAdapter: (descriptor: MediaProviderDescriptor) => {
    const stub = mockAdapters.get(descriptor.id)
    if (!stub) {
      throw new Error(`No stub adapter registered for "${descriptor.id}"`)
    }
    return stub
  },
  UnknownMediaAdapterError: class UnknownMediaAdapterError extends Error {},
}))

const TASKS: MediaTaskPresentation[] = [
  {
    id: MEDIA_TASK.TEXT_TO_IMAGE,
    label: 'Text → Image',
    output_media_type: 'image',
    order: 0,
  },
]

function providerFor(
  id: string,
  label: string,
  overrides: Partial<MediaProviderDescriptor> = {}
): MediaProviderDescriptor {
  return {
    id,
    label,
    kind: 'local_worker',
    adapter: 'atomic-media-worker',
    base_url: `http://127.0.0.1:1342${id.length}`,
    auth: { type: 'none' },
    enabled: true,
    origin: 'builtin',
    order: 0,
    ...overrides,
  }
}

function modelFor(
  providerId: string,
  localId: string,
  overrides: Partial<MediaModelDescriptor> = {}
): MediaModelDescriptor {
  return {
    id: `${providerId}:${localId}`,
    provider_id: providerId,
    local_id: localId,
    label: localId,
    tasks: [MEDIA_TASK.TEXT_TO_IMAGE],
    params: { [MEDIA_TASK.TEXT_TO_IMAGE]: [] },
    ...overrides,
  }
}

function capabilitiesFor(
  providerId: string,
  models: MediaModelDescriptor[],
  features: MediaCapabilities['features'] = {}
): MediaCapabilities {
  return {
    contract_version: 2,
    provider_id: providerId,
    devices: [],
    models,
    tasks: TASKS,
    features,
  }
}

/** Register a stub adapter that answers health and capabilities. */
function stubAdapter(
  providerId: string,
  options: {
    health?: MediaProviderHealth
    capabilities?: MediaCapabilities
    healthError?: Error
    install?: MediaProviderAdapter['install']
  } = {}
) {
  mockAdapters.set(providerId, {
    health: async () => {
      if (options.healthError) throw options.healthError
      return options.health ?? { state: 'online' }
    },
    capabilities: async () =>
      options.capabilities ?? capabilitiesFor(providerId, []),
    install: options.install,
  })
}

/** Put the store into a known state; it persists to localStorage otherwise. */
function seedStore(providers: MediaProviderDescriptor[]) {
  useMediaProviderStore.setState({
    providers,
    health: {},
    capabilities: {},
    errors: {},
    selectedModelId: null,
    refreshing: false,
  })
}

beforeEach(() => {
  mockAdapters.clear()
  mockSecrets.clear()
  localStorage.clear()
  // The registry caches into localStorage, so one test's payload would
  // otherwise still be fresh for the next.
  clearMediaRegistryCache()
  seedStore([])
})

describe('adding a provider', () => {
  it.each(['replicate', 'fal-ai', 'stability-ai'])(
    'offers %s with an OS credential field',
    async (adapter) => {
      render(<ProviderList />)
      fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
      fireEvent.change(screen.getByLabelText('Adapter'), {
        target: { value: adapter },
      })
      expect(screen.getByLabelText('Adapter')).toHaveValue(adapter)
      await waitFor(() =>
        expect(screen.getByLabelText('API key')).toHaveAttribute(
          'type',
          'password'
        )
      )
    }
  )

  it('offers AUTOMATIC1111 as a local provider', async () => {
    await act(async () => {
      render(<ProviderList />)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    expect(screen.getByRole('option', { name: 'AUTOMATIC1111' })).toHaveValue(
      'a1111'
    )
  })
  it('adds a custom provider and shows it in the list', async () => {
    seedStore([providerFor('bundled', 'Radium Media Worker')])
    stubAdapter('bundled')
    stubAdapter('my-comfyui')

    render(<ProviderList />)

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'My ComfyUI' },
    })
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'http://127.0.0.1:8188' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }))

    expect(await screen.findByText('My ComfyUI')).toBeInTheDocument()

    const added = useMediaProviderStore
      .getState()
      .providers.find((provider) => provider.label === 'My ComfyUI')
    expect(added?.base_url).toBe('http://127.0.0.1:8188')
    expect(added?.origin).toBe('user')
  })
})

describe('one bad provider does not break the others', () => {
  it('shows the failing provider its own error and still lists the healthy one', async () => {
    seedStore([
      providerFor('good', 'Good Worker'),
      providerFor('bad', 'Bad Worker', { base_url: 'http://nope.invalid' }),
    ])
    stubAdapter('good', {
      capabilities: capabilitiesFor('good', [modelFor('good', 'sdxl')]),
    })
    stubAdapter('bad', { healthError: new Error('ECONNREFUSED') })

    render(<ProviderList />)

    // The failing provider names its own failure...
    expect(await screen.findByText(/ECONNREFUSED/)).toBeInTheDocument()

    // ...and the healthy one is unaffected: still online, still has its model.
    const state = useMediaProviderStore.getState()
    expect(state.health.good?.state).toBe('online')
    expect(state.errors.good).toBeNull()
    expect(state.capabilities.good?.models).toHaveLength(1)
    expect(screen.getByText('Good Worker')).toBeInTheDocument()
  })
})

describe('enabling a provider reaches the studio', () => {
  it('makes a disabled provider models selectable once it is switched on', async () => {
    seedStore([
      providerFor('extra', 'Extra Worker', { enabled: false, origin: 'user' }),
    ])
    stubAdapter('extra', {
      capabilities: capabilitiesFor('extra', [modelFor('extra', 'flux')]),
    })

    render(<ProviderList />)

    // Disabled, so the studio has nothing to offer from it.
    expect(useMediaProviderStore.getState().models()).toHaveLength(0)

    fireEvent.click(screen.getByRole('switch', { name: 'Enable Extra Worker' }))

    await waitFor(() => {
      expect(useMediaProviderStore.getState().models()).toHaveLength(1)
    })

    // And the studio actually renders it as a choice.
    render(
      <MediaGenerationForm
        tasks={TASKS}
        task={MEDIA_TASK.TEXT_TO_IMAGE}
        onTaskChange={vi.fn()}
        models={useMediaProviderStore.getState().models()}
        providers={useMediaProviderStore.getState().providers}
        devices={[]}
        selectedModelId="extra:flux"
        onSelectModel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(await screen.findByText('flux')).toBeInTheDocument()
  })
})

describe('installing a model', () => {
  it('renders install progress and then the installed state', async () => {
    const model = modelFor('local', 'sdxl', {
      install: { installed: false, installable: true, size_bytes: 100 },
    })
    // The install is held open deliberately. Without the gate the stub would
    // resolve in the same tick it reports progress, and the progress bar could
    // be replaced by "Installed" before the assertion ever sees it - a test
    // that passes or fails on scheduling rather than on behaviour.
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    seedStore([providerFor('local', 'Local Worker')])
    stubAdapter('local', {
      capabilities: capabilitiesFor('local', [model], { install: true }),
      install: async (_id, onProgress) => {
        onProgress({ received: 50, total: 100 })
        await held
      },
    })

    render(<ModelCatalog providerId="local" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    // Both halves: the bar now announces its value (D16 fixed the shared
    // primitive), and the number is readable on screen.
    expect(await screen.findByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '50'
    )
    expect(await screen.findByText('50%')).toBeInTheDocument()

    release()

    expect(await screen.findByText('Installed')).toBeInTheDocument()
  })

  it('surfaces an install failure and lets the user try again', async () => {
    const model = modelFor('local', 'sdxl', {
      install: { installed: false, installable: true },
    })
    const install = vi
      .fn<MediaProviderAdapter['install']>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementationOnce(async (_id, onProgress) => {
        onProgress({ received: 100, total: 100 })
      })

    seedStore([providerFor('local', 'Local Worker')])
    stubAdapter('local', {
      capabilities: capabilitiesFor('local', [model], { install: true }),
      install,
    })

    render(<ModelCatalog providerId="local" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    // The failure is named, not swallowed into a silent no-op.
    expect(await screen.findByText(/disk full/)).toBeInTheDocument()

    // Recoverable: the action is offered again rather than the row being stuck.
    const retry = await screen.findByRole('button', { name: 'Install' })
    expect(retry).toBeEnabled()

    fireEvent.click(retry)
    expect(await screen.findByText('Installed')).toBeInTheDocument()
  })
})

describe('provider secrets', () => {
  it('masks an API key and never puts it in the DOM or the store', async () => {
    seedStore([])
    stubAdapter('cloud-images')

    const { container } = render(<ProviderList />)

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Cloud Images' },
    })
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://api.example.com' },
    })
    // An adapter that actually authenticates. Without this the provider needs
    // no credential, the whole key path is skipped, and every assertion below
    // passes for the wrong reason - which is exactly what a mutation that
    // leaked the key into the descriptor proved on 2026-09-10.
    fireEvent.change(screen.getByLabelText('Adapter'), {
      target: { value: 'openai-images' },
    })

    const key = screen.getByLabelText('API key')
    expect(key).toHaveAttribute('type', 'password')

    fireEvent.change(key, { target: { value: 'sk-super-secret-value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }))

    await screen.findByText('Cloud Images')

    // Never rendered in plaintext anywhere on the settings surface.
    expect(container.innerHTML).not.toContain('sk-super-secret-value')

    // And never persisted into the provider store, which is not a secret store.
    const saved = JSON.stringify(useMediaProviderStore.getState().providers)
    expect(saved).not.toContain('sk-super-secret-value')

    // The descriptor must still record WHERE the credential lives, otherwise
    // "no secret in the store" would be satisfiable by simply dropping the key
    // on the floor. It holds a pointer, and the pointer is not the secret.
    const cloud = useMediaProviderStore
      .getState()
      .providers.find((provider) => provider.label === 'Cloud Images')
    expect(cloud?.auth?.type).toBe('api_key')
    expect(cloud?.auth?.setting_key).toBe('media.cloud-images.api_key')
    expect(await getMediaProviderSecret('cloud-images')).toBe(
      'sk-super-secret-value'
    )
  })
})

/**
 * Task 15 Step 5 - the registry Refresh button.
 *
 * The promise being pinned is the one that protects the user's own work: the
 * registry only ever ADDS. A provider they already have - including one they
 * disabled or pointed somewhere else - must survive a registry refresh
 * untouched, because their configuration is theirs and a commit in another
 * repository must not be able to overwrite it.
 */
/** A registry payload offering one hosted provider. */
function stubRegistry(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        schema_version: 1,
        updated_at: '2026-09-10T00:00:00Z',
        providers: [
          {
            id: 'hosted-images',
            label: 'Hosted Images',
            kind: 'remote_http',
            adapter: 'openai-images',
            base_url: 'https://api.example.com/v1',
            ...overrides,
          },
        ],
      }),
    })) as unknown as typeof fetch
  )
}

describe('the remote registry', () => {
  it('adds providers the user does not have yet', async () => {
    seedStore([providerFor('bundled', 'Radium Media Worker')])
    stubAdapter('bundled')
    stubAdapter('hosted-images')
    stubRegistry()

    render(<ProviderList />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Check for new providers' })
    )

    expect(await screen.findByText('Hosted Images')).toBeInTheDocument()
  })

  it('never overwrites a provider the user already configured', async () => {
    // The user disabled it and pointed it somewhere of their own.
    seedStore([
      providerFor('hosted-images', 'My Own Name', {
        base_url: 'http://127.0.0.1:9999',
        enabled: false,
        origin: 'user',
      }),
    ])
    stubAdapter('hosted-images')
    // The registry really does offer an entry with the same id, so this test
    // exercises the collision rather than passing because nothing came back.
    stubRegistry({ label: 'Registry Name', base_url: 'https://vendor.example' })

    render(<ProviderList />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Check for new providers' })
    )

    await waitFor(() => {
      expect(useMediaProviderStore.getState().registryLoading).toBe(false)
    })

    const kept = useMediaProviderStore
      .getState()
      .providers.filter((provider) => provider.id === 'hosted-images')

    expect(kept).toHaveLength(1)
    expect(kept[0]!.label).toBe('My Own Name')
    expect(kept[0]!.base_url).toBe('http://127.0.0.1:9999')
    expect(kept[0]!.enabled).toBe(false)
  })
})
