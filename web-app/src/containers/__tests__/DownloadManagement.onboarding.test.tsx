import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ models: () => ({ abortDownload: vi.fn() }) }),
  getServiceHub: () => ({}),
}))
// The rows the panel is handed, by id.
vi.mock('@/containers/downloads/DownloadPanel', () => ({
  DownloadPanel: ({ items }: { items: Array<{ id: string }> }) => (
    <ul data-testid="download-panel">
      {items.map((item) => (
        <li key={item.id}>{item.id}</li>
      ))}
    </ul>
  ),
}))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/sentry', () => ({ captureHandledError: vi.fn() }))

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useOnboardingStore } from '@/stores/onboarding-store'
import { DownloadManagement } from '../DownloadManegement'

const CHAT = 'Qwen3.5-4B-Q4_K_M'
const OTHER = 'Llama-3.2-3B-Q4_K_M'

const row = (id: string) => ({
  id,
  name: id,
  progress: 0.4,
  current: 40,
  total: 100,
})

const rows = () =>
  Array.from(
    screen.getByTestId('download-panel').querySelectorAll('li'),
    (item) => item.textContent
  )

describe('DownloadManagement during a first run', () => {
  beforeEach(() => {
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useDownloadStore.setState({
      downloads: { [CHAT]: row(CHAT), [OTHER]: row(OTHER) },
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      resumableDownloads: new Set(),
      resumeParams: {},
    } as never)
    const store = useOnboardingStore.getState()
    store.begin('full', 'model')
    store.enqueue({
      key: 'chat',
      kind: 'chat',
      title: 'Qwen3.5 4B',
      taskId: CHAT,
      phase: 'running',
    })
  })

  it('draws no panel on the setup screen, which shows its own strip', () => {
    render(<DownloadManagement hidePanel />)

    expect(rows()).toEqual([])
  })

  // The handoff panel stays away meanwhile: one card per download.
  it.each(['chat', 'endpoint'] as const)(
    'lists the run’s downloads itself after a handoff to %s',
    (destination) => {
      useOnboardingStore.getState().handOff(destination)
      render(<DownloadManagement />)

      expect(rows()).toEqual([CHAT, OTHER])
    }
  )
})
