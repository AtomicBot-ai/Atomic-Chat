import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

import type { PrismEngine } from '@/hooks/usePrismEngine'
import {
  PrismEngineInstallButton,
  PrismEngineSetupCard,
} from '../PrismEngineSetupCard'

const BUILD = 'prism-b10754-2459f68/macos-arm64'

const engine = (over: Partial<PrismEngine> = {}): PrismEngine => ({
  present: true,
  status: { installed: false, recommended: BUILD },
  checkError: null,
  installing: false,
  installError: null,
  check: vi.fn(async () => {}),
  install: vi.fn(async () => {}),
  ...over,
})

describe('PrismEngineSetupCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says in one line what the engine is for, and leads to the Hub’s PrismML list', () => {
    render(<PrismEngineSetupCard engine={engine()} versionBackend="none" />)

    expect(screen.getByTestId('prism-engine-setup')).toHaveTextContent(
      'providers:prismEngine.description'
    )
    expect(screen.queryByTestId('prism-engine-no-build')).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: 'providers:prismEngine.findModels' })
    )
    expect(navigate.mock.calls).toEqual([
      [{ to: '/hub/', search: { engine: 'atomic-prism' } }],
    ])
  })

  it('says why there is nothing to install', () => {
    render(
      <PrismEngineSetupCard
        engine={engine({ status: { installed: false, recommended: null } })}
        versionBackend="none"
      />
    )

    expect(screen.getByTestId('prism-engine-no-build')).toHaveTextContent(
      'providers:prismEngine.noBuild'
    )
  })

  it('renders nothing once a build is on disk', () => {
    const { container } = render(
      <PrismEngineSetupCard
        engine={engine({ status: { installed: true, recommended: BUILD } })}
        versionBackend={BUILD}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('says nothing for a configured build until the core confirms it is missing', () => {
    const { container } = render(
      <PrismEngineSetupCard
        engine={engine({ status: null })}
        versionBackend={BUILD}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a failed check and an install that failed, with a way to check again', () => {
    const failing = engine({
      status: null,
      checkError: 'core restarting',
      installError: 'disk full',
    })
    render(<PrismEngineSetupCard engine={failing} versionBackend="none" />)

    expect(
      screen.getByText(/providers:prismEngine.checkFailed/)
    ).toHaveTextContent('core restarting')
    expect(screen.getByRole('alert')).toHaveTextContent('disk full')
    fireEvent.click(
      screen.getByRole('button', { name: 'providers:prismEngine.checkAgain' })
    )
    expect(failing.check).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('prism-engine-setup')).toBeInTheDocument()
  })
})

describe('PrismEngineInstallButton', () => {
  it('installs the recommended build in one click', () => {
    const ready = engine()
    render(<PrismEngineInstallButton engine={ready} />)

    const button = screen.getByTestId('prism-engine-install')
    expect(button).toHaveTextContent('providers:prismEngine.install')
    expect(button).toHaveAttribute('title', BUILD)
    fireEvent.click(button)
    expect(ready.install).toHaveBeenCalledTimes(1)
  })

  it('waits, disabled, while the core is asked and while the build installs', () => {
    const { rerender } = render(
      <PrismEngineInstallButton engine={engine({ status: null })} />
    )
    expect(screen.getByTestId('prism-engine-install')).toBeDisabled()

    rerender(<PrismEngineInstallButton engine={engine({ installing: true })} />)
    expect(screen.getByTestId('prism-engine-install')).toBeDisabled()
    expect(screen.getByTestId('prism-engine-install')).toHaveTextContent(
      'providers:prismEngine.installing'
    )
  })

  it('cannot install when the core offers no build', () => {
    render(
      <PrismEngineInstallButton
        engine={engine({ status: { installed: false, recommended: null } })}
      />
    )
    expect(screen.getByTestId('prism-engine-install')).toBeDisabled()
  })
})
