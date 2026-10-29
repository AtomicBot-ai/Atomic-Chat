import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  setFontSize,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

// Geometry only: nothing is started, configured or detected here.
vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    status: 'stopped',
    isRunning: false,
    isModelLoading: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn(),
  }),
}))
vi.mock('@/hooks/useServiceHub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useServiceHub')>()),
  useServiceHub: () => ({}),
}))
vi.mock('@/lib/integration-agent-detection', () => ({
  detectIntegrationAgentsOnce: vi.fn(),
  detectIntegrationAgent: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => <a className={className}>{children}</a>,
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { pathname: '/api' } } }),
}))

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useLaunchStore } from '@/stores/launch-store'

import { ServerAgents } from './ServerAgents'
import { ServerSetupGuide } from './ServerSetupGuide'

// Overview's column at a 1024 px window: the window less the 60 px rail,
// the 256 px sidebar and the page's padding.
const COLUMN_WIDTH = 676

describe('Overview setup guide and agents', () => {
  beforeEach(() => {
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      defaultModelLocalApiServer: null,
      lastServerModels: [],
    })
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          persist: true,
          settings: [],
          models: [
            {
              id: 'unsloth/Qwen3.5-35B-A3B-Instruct-UD-Q4_K_XL-with-a-long-name',
            },
          ],
        } as unknown as ModelProvider,
      ],
    })
    useLaunchStore.setState({ installed: { 'claude-code': false } })
  })
  afterEach(() => setFontSize(DEFAULT_FONT_SIZE))

  it.each([DEFAULT_FONT_SIZE, XL_FONT_SIZE])(
    'keeps the review step and the agent cards inside the column (%s)',
    async (fontSize) => {
      setFontSize(fontSize)
      render(
        withTranslations(
          <div
            className="server-page server-page-wide"
            style={{ width: COLUMN_WIDTH }}
            data-testid="page"
          >
            <ServerSetupGuide
              entry={{ path: 'agent', agentId: 'claude-code' }}
            />
            <ServerAgents />
          </div>
        )
      )
      const page = screen.getByTestId('page')
      await settle(page)

      expectNoHorizontalOverflow(page)
      const configure = screen.getByRole('button', {
        name: /Configure & start/,
      })
      expect(configure.getBoundingClientRect().height).toBeCloseTo(28, 0)
      expectFits(configure, page)
    }
  )
})
