import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Route as HttpsProxyRoute } from '../https-proxy'
import { useProxyConfig } from '@/hooks/useProxyConfig'

const invoke = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()
const toastWarning = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
  },
}))

vi.mock('@/containers/SettingsMenu', () => ({ default: () => <div /> }))
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/containers/Card', () => ({
  Card: ({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
  CardItem: ({
    title,
    description,
    actions,
  }: {
    title?: React.ReactNode
    description?: React.ReactNode
    actions?: React.ReactNode
  }) => (
    <div>
      {title}
      {description}
      {actions}
    </div>
  ),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/constants/routes', () => ({
  route: { settings: { https_proxy: '/settings/https-proxy' } },
}))
vi.mock('@tanstack/react-router', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createFileRoute: () => (config: any) => ({ ...config }),
}))

const renderPage = () => {
  const Component = HttpsProxyRoute.component as React.ComponentType
  return render(<Component />)
}

const clickTest = async () => {
  const user = userEvent.setup()
  await user.click(screen.getByText('settings:httpsProxy.test'))
}

/**
 * ATO — #290/#289: `validate_proxy_config` only ever checked URL syntax, so a
 * proxy at a dead address was discovered by a model download or a project
 * upload failing a minute later, with a message naming neither.
 */
describe('HTTPS proxy settings — Test connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProxyConfig.setState({
      proxyEnabled: false,
      proxyUrl: '',
      proxyUsername: '',
      proxyPassword: '',
      proxyIgnoreSSL: false,
      noProxy: '',
    })
  })

  it('refuses to test an empty address without calling the backend', async () => {
    renderPage()
    await clickTest()

    expect(invoke).not.toHaveBeenCalled()
    expect(toastWarning).toHaveBeenCalled()
  })

  it('tests the address typed in the form, even before the proxy is enabled', async () => {
    // Testing before switching the proxy on is exactly when this is useful, so
    // it must not depend on `proxyEnabled`.
    useProxyConfig.setState({
      proxyUrl: 'http://192.168.1.218:1234',
      proxyUsername: 'u',
      proxyPassword: 'p',
      noProxy: 'localhost, 127.0.0.1',
      proxyIgnoreSSL: true,
    })
    invoke.mockResolvedValue({ ok: true, kind: 'ok', detail: 'HTTP 200 OK' })

    renderPage()
    await clickTest()

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke).toHaveBeenCalledWith('test_proxy_connection', {
      config: {
        url: 'http://192.168.1.218:1234',
        ignore_ssl: true,
        username: 'u',
        password: 'p',
        no_proxy: ['localhost', '127.0.0.1'],
      },
    })
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('reports a refused proxy as an error, not a success', async () => {
    useProxyConfig.setState({ proxyUrl: 'http://192.168.1.218:1234' })
    invoke.mockResolvedValue({
      ok: false,
      kind: 'unreachable',
      detail: 'tcp connect error (os error 10061)',
    })

    renderPage()
    await clickTest()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError.mock.calls[0][0]).toBe(
      'settings:httpsProxy.testUnreachable'
    )
  })

  it('warns rather than congratulates when no_proxy skips the proxy entirely', async () => {
    useProxyConfig.setState({
      proxyUrl: 'http://192.168.1.218:1234',
      noProxy: 'huggingface.co',
    })
    invoke.mockResolvedValue({ ok: true, kind: 'bypassed', detail: '' })

    renderPage()
    await clickTest()

    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('surfaces a rejected invoke instead of hanging on the spinner', async () => {
    useProxyConfig.setState({ proxyUrl: 'http://192.168.1.218:1234' })
    invoke.mockRejectedValue(new Error('Command test_proxy_connection not found'))

    renderPage()
    await clickTest()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // The button goes back to its idle label rather than staying disabled.
    await waitFor(() =>
      expect(screen.getByText('settings:httpsProxy.test')).toBeTruthy()
    )
  })
})
