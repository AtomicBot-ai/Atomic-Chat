import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Route as GeneralRoute } from '../general'
import type { ServiceHub } from '@/services'
import { seedServiceHub } from '@/test/service-hub'
import i18n from '@/i18n/setup'

const translation = vi.hoisted(() => ({ french: false }))

// Mock all the dependencies
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/containers/Card', () => ({
  Card: ({
    title,
    children,
  }: {
    title?: string
    children: React.ReactNode
  }) => (
    <div data-testid="card" data-title={title}>
      {title && <div data-testid="card-title">{title}</div>}
      {children}
    </div>
  ),
  CardItem: ({
    title,
    description,
    actions,
    className,
  }: {
    title?: string
    description?: string
    actions?: React.ReactNode
    className?: string
  }) => (
    <div data-testid="card-item" data-title={title} className={className}>
      {title && <div data-testid="card-item-title">{title}</div>}
      {description && (
        <div data-testid="card-item-description">{description}</div>
      )}
      {actions && <div data-testid="card-item-actions">{actions}</div>}
    </div>
  ),
}))

vi.mock('@/containers/LanguageSwitcher', () => ({
  default: () => <div data-testid="language-switcher">Language Switcher</div>,
}))

vi.mock('@/containers/dialogs/ChangeDataFolderLocation', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="change-data-folder-dialog">{children}</div>
  ),
}))

const mockSetPreloadModelOnStartup = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: () => ({
    spellCheckChatInput: true,
    setSpellCheckChatInput: vi.fn(),
    huggingfaceToken: 'test-token',
    setHuggingfaceToken: vi.fn(),
    preloadModelOnStartup: false,
    setPreloadModelOnStartup: mockSetPreloadModelOnStartup,
  }),
}))

// Create a controllable mock
const mockCheckForUpdateNow = vi.fn()
const mockOpenerOpen = vi.fn()
const mockRevealItemInDir = vi.fn()
const mockExportLogs = vi.fn()
const mockOpenPath = vi.fn()
const mockGetCoreVersion = vi.fn()

const updater = vi.hoisted(() => ({ packageManaged: false }))

vi.mock('@/hooks/useAppUpdater', () => ({
  useAppUpdater: () => ({
    checkForUpdateNow: mockCheckForUpdateNow,
    packageManaged: updater.packageManaged,
  }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => (translation.french ? i18n.t(key) : key),
  }),
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }) => (
    <input
      data-testid="switch"
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    [key: string]: any
  }) => (
    <button
      data-testid="button"
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ),
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
    placeholder?: string
  }) => (
    <input
      data-testid="input"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  ),
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog">{children}</div>
  ),
  DialogClose: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-close">{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-description">{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-title">{children}</div>
  ),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-trigger">{children}</div>
  ),
}))

vi.mock('@/services/app/web', () => ({
  WebAppService: vi.fn().mockImplementation(() => ({
    factoryReset: vi.fn(),
    getJanDataFolder: vi.fn().mockResolvedValue('/test/data/folder'),
    relocateJanDataFolder: vi.fn(),
  })),
}))

vi.mock('@/services/models/default', () => ({
  DefaultModelsService: vi.fn().mockImplementation(() => ({
    stopAllModels: vi.fn(),
  })),
}))

// Add tests for rfd dialog
// vi.mock('@tauri-apps/plugin-dialog', () => ({
//   open: vi.fn(),
// }))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => {
  const MockWebviewWindow = vi
    .fn()
    .mockImplementation((label: string, options: any) => ({
      once: vi.fn(),
      setFocus: vi.fn(),
    }))
  MockWebviewWindow.getByLabel = vi.fn().mockReturnValue(null)

  return {
    WebviewWindow: MockWebviewWindow,
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  isDev: vi.fn().mockReturnValue(false),
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      general: '/settings/general',
    },
    appLogs: '/logs',
  },
}))

vi.mock('@/constants/windows', () => ({
  windowKey: {
    logsAppWindow: 'logs-app-window',
  },
}))

vi.mock('@/types/events', () => ({
  SystemEvent: {
    KILL_SIDECAR: 'kill-sidecar',
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (path: string) => (config: any) => ({
    ...config,
    component: config.component,
  }),
}))

// Mock global variables
global.VERSION = '1.0.0'
global.IS_MACOS = false
global.IS_WINDOWS = true
global.AUTO_UPDATER_DISABLED = false
global.window = {
  ...global.window,
  core: {
    api: {
      relaunch: vi.fn(),
      getConnectedServers: vi.fn().mockResolvedValue([]),
    },
  },
}

// Mock navigator clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(),
  },
})

describe('General Settings Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    translation.french = false
    updater.packageManaged = false
    seedServiceHub({
      app: {
        factoryReset: vi.fn(),
        getJanDataFolder: vi.fn().mockResolvedValue('/test/data/folder'),
        relocateJanDataFolder: vi.fn(),
        exportLogs: mockExportLogs,
        getCoreVersion: mockGetCoreVersion,
      } as unknown as ReturnType<ServiceHub['app']>,
      models: {
        stopAllModels: vi.fn(),
      } as ReturnType<ServiceHub['models']>,
      dialog: {
        open: vi.fn().mockResolvedValue('/test/path'),
      } as ReturnType<ServiceHub['dialog']>,
      events: {
        emit: vi.fn(),
      } as ReturnType<ServiceHub['events']>,
      window: {
        openLogsWindow: vi.fn(),
      } as ReturnType<ServiceHub['window']>,
      opener: {
        open: mockOpenerOpen,
        revealItemInDir: mockRevealItemInDir,
        openPath: mockOpenPath,
      } as ReturnType<ServiceHub['opener']>,
    })
    // Reset the mock to return a promise that resolves immediately by default
    mockCheckForUpdateNow.mockResolvedValue({ status: 'up-to-date' })
    mockOpenerOpen.mockResolvedValue(undefined)
    mockRevealItemInDir.mockResolvedValue(undefined)
    mockGetCoreVersion.mockResolvedValue('0.7.1')
  })

  it('renders the reported general settings labels and thinking options in French', async () => {
    translation.french = true
    const previousLanguage = i18n.language
    i18n.language = 'fr'
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })
    for (const text of [
      'Précharger le dernier modèle utilisé au démarrage',
      'Nous contacter',
      'Comportement du chat',
      'Effort de réflexion (modèles locaux)',
    ])
      expect(screen.getByText(text)).toBeVisible()
    expect(
      screen.getByRole('option', { name: 'Faible (256 jetons)' })
    ).toBeInTheDocument()
    expect(screen.queryByText('Contact Us')).toBeNull()
    expect(screen.queryByText('Thinking effort (local models)')).toBeNull()
    i18n.language = previousLanguage
  })

  it('should render the general settings page', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByText('common:settings')).toBeInTheDocument()
  })

  it('should render app version', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
  })

  it('renders the core version right under the app version', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const titles = screen
      .getAllByTestId('card-item')
      .map((el) => el.getAttribute('data-title'))
    const appRow = titles.indexOf('settings:general.appVersion')
    expect(titles[appRow + 1]).toBe('settings:general.coreVersion')
    expect(screen.getByText('v0.7.1')).toBeInTheDocument()
  })

  it('leaves the core version out when the app cannot tell it', async () => {
    mockGetCoreVersion.mockResolvedValue(undefined)
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
    expect(
      screen
        .getAllByTestId('card-item')
        .some(
          (el) =>
            el.getAttribute('data-title') === 'settings:general.coreVersion'
        )
    ).toBe(false)
  })

  // TODO: This test is currently commented out due to missing implementation
  // it('should render language switcher', () => {
  //   const Component = GeneralRoute.component as React.ComponentType
  //   render(<Component />)

  //   expect(screen.getByTestId('language-switcher')).toBeInTheDocument()
  // })

  it('should render huggingface token input', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const input = screen.getByTestId('input')
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue('test-token')
  })

  it('should handle spell check toggle', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const switches = screen.getAllByTestId('switch')
    expect(switches.length).toBeGreaterThan(0)

    // Test that switches are interactive
    await act(async () => {
      fireEvent.click(switches[0])
    })
    expect(switches[0]).toBeInTheDocument()
  })

  it('renders the model preload toggle off, next to the startup settings', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const item = screen
      .getAllByTestId('card-item')
      .find(
        (el) =>
          el.getAttribute('data-title') ===
          'settings:general.preloadModelOnStartup'
      )
    expect(item).toBeDefined()

    // It belongs to the General card, alongside "Launch at startup" — not to
    // the "Others" card it used to live in.
    expect(item?.closest('[data-testid="card"]')).toHaveAttribute(
      'data-title',
      'common:general'
    )

    const toggle = item?.querySelector(
      '[data-testid="switch"]'
    ) as HTMLInputElement
    expect(toggle).toBeDefined()
    expect(toggle.checked).toBe(false)

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(mockSetPreloadModelOnStartup).toHaveBeenCalledWith(true)
  })

  it('should handle huggingface token change', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const input = screen.getByTestId('input')
    expect(input).toBeInTheDocument()

    // Test that input is interactive
    await act(async () => {
      fireEvent.change(input, { target: { value: 'new-token' } })
    })
    expect(input).toBeInTheDocument()
  })

  it('should handle check for updates', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const buttons = screen.getAllByTestId('button')
    const checkUpdateButton = buttons.find((button) =>
      button.textContent?.includes('checkForUpdates')
    )

    if (checkUpdateButton) {
      expect(checkUpdateButton).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(checkUpdateButton)
      })
      // Test that button is interactive
      expect(checkUpdateButton).toBeInTheDocument()
    }
  })

  // QA 2.2.25 NEW-01: the result of a check stays on the row and is
  // announced, instead of a toast that was easy to miss.
  describe('update check result', () => {
    const clickCheckForUpdates = async () => {
      const button = screen
        .getAllByTestId('button')
        .find((candidate) =>
          candidate.textContent?.includes('settings:general.checkForUpdates')
        )
      expect(button).toBeDefined()
      await act(async () => {
        fireEvent.click(button!)
      })
    }

    const renderPage = async () => {
      const Component = GeneralRoute.component as React.ComponentType
      await act(async () => {
        render(<Component />)
      })
    }

    it('describes the check until one has been made', async () => {
      await renderPage()

      expect(screen.getByRole('status')).toHaveTextContent(
        'settings:general.checkForUpdatesDesc'
      )
    })

    it('says the app is up to date, and keeps saying it', async () => {
      await renderPage()
      await clickCheckForUpdates()

      expect(mockCheckForUpdateNow).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('status')).toHaveTextContent(
        'settings:general.updateCheckUpToDate'
      )
    })

    it('names an available update', async () => {
      mockCheckForUpdateNow.mockResolvedValue({
        status: 'available',
        update: { version: '2.2.26' },
      })
      await renderPage()
      await clickCheckForUpdates()

      expect(screen.getByRole('status')).toHaveTextContent(
        'settings:general.updateCheckAvailable'
      )
    })

    it('tells a failed check from an up-to-date app and offers to try again', async () => {
      mockCheckForUpdateNow.mockResolvedValue({ status: 'failed' })
      await renderPage()
      await clickCheckForUpdates()

      expect(screen.getByRole('status')).toHaveTextContent(
        'settings:general.updateCheckFailed'
      )
      const retry = screen
        .getAllByTestId('button')
        .find((button) =>
          button.textContent?.includes('settings:general.updateCheckRetry')
        )
      expect(retry).toBeDefined()

      mockCheckForUpdateNow.mockResolvedValue({ status: 'up-to-date' })
      await act(async () => {
        fireEvent.click(retry!)
      })
      expect(screen.getByRole('status')).toHaveTextContent(
        'settings:general.updateCheckUpToDate'
      )
    })

    it('says a development build does not check', async () => {
      mockCheckForUpdateNow.mockResolvedValue({
        status: 'not-checked',
        reason: 'development',
      })
      await renderPage()
      await clickCheckForUpdates()

      expect(screen.getByRole('status')).toHaveTextContent(
        'settings:general.updateCheckDevelopment'
      )
    })

    it('says a build without the updater gets its updates elsewhere', async () => {
      global.AUTO_UPDATER_DISABLED = true
      try {
        await renderPage()

        expect(
          screen.getByText('settings:general.updatesDisabled')
        ).toBeInTheDocument()
        expect(
          screen
            .getAllByTestId('button')
            .some((button) => button.textContent?.includes('checkForUpdates'))
        ).toBe(false)
      } finally {
        global.AUTO_UPDATER_DISABLED = false
      }
    })
  })

  it('points a package-managed install at its package manager instead of offering updates', async () => {
    updater.packageManaged = true
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(
      screen.getByText('settings:general.updatesByPackageManager')
    ).toBeInTheDocument()
    expect(
      screen
        .getAllByTestId('button')
        .some((button) => button.textContent?.includes('checkForUpdates'))
    ).toBe(false)
  })

  it('still explains a package-managed install when the build has no updater', async () => {
    // A source-built distro package can set both switches; the explanation
    // must not disappear with the update button.
    updater.packageManaged = true
    global.AUTO_UPDATER_DISABLED = true
    try {
      const Component = GeneralRoute.component as React.ComponentType
      await act(async () => {
        render(<Component />)
      })

      expect(
        screen.getByText('settings:general.updatesByPackageManager')
      ).toBeInTheDocument()
      expect(
        screen
          .getAllByTestId('button')
          .some((button) => button.textContent?.includes('checkForUpdates'))
      ).toBe(false)
    } finally {
      global.AUTO_UPDATER_DISABLED = false
    }
  })

  it('should handle data folder display', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    // Test that component renders without errors
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
  })

  it('should handle copy to clipboard', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    // Test that component renders without errors
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
  })

  it('should handle factory reset dialog', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(screen.getByTestId('dialog')).toBeInTheDocument()
    expect(screen.getByTestId('dialog-trigger')).toBeInTheDocument()
    expect(screen.getByTestId('dialog-content')).toBeInTheDocument()
  })

  it('should render external links', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    // Check for external links
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
  })

  it('should open support email through opener service', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const emailLink = screen.getByRole('link', { name: 'support@atomic.chat' })

    await act(async () => {
      fireEvent.click(emailLink)
    })

    expect(mockOpenerOpen).toHaveBeenCalledWith('mailto:support@atomic.chat')
  })

  it('should handle logs window opening', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const buttons = screen.getAllByTestId('button')
    const openLogsButton = buttons.find((button) =>
      button.textContent?.includes('openLogs')
    )

    if (openLogsButton) {
      expect(openLogsButton).toBeInTheDocument()
      // Test that button is interactive
      await act(async () => {
        fireEvent.click(openLogsButton)
      })
      expect(openLogsButton).toBeInTheDocument()
    }
  })

  it('should handle reveal logs folder', async () => {
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const buttons = screen.getAllByTestId('button')
    const revealLogsButton = buttons.find((button) =>
      button.textContent?.includes('showInFileExplorer')
    )

    if (revealLogsButton) {
      expect(revealLogsButton).toBeInTheDocument()
      // Test that button is interactive
      await act(async () => {
        fireEvent.click(revealLogsButton)
      })
      expect(revealLogsButton).toBeInTheDocument()
    }
  })

  it('exports the logs from the App Logs row and says where they went', async () => {
    const { toast } = await import('sonner')
    mockExportLogs.mockResolvedValue({
      path: 'C:\\Users\\me\\Desktop\\atomic-chat-logs.log',
      bytes: 42,
    })
    mockOpenPath.mockResolvedValue(undefined)
    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const exportButton = screen
      .getAllByTestId('button')
      .find((button) => button.textContent?.includes('exportLogs'))!
    await act(async () => {
      fireEvent.click(exportButton)
    })

    expect(mockExportLogs).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith(
      'logs:exported',
      expect.objectContaining({
        description: 'C:\\Users\\me\\Desktop\\atomic-chat-logs.log',
      })
    )
    const options = vi.mocked(toast.success).mock.calls[0][1] as {
      action: { onClick: () => void }
    }
    options.action.onClick()
    expect(mockOpenPath).toHaveBeenCalledWith('C:\\Users\\me\\Desktop')
  })

  it('should show correct file explorer text for Windows', async () => {
    global.IS_WINDOWS = true
    global.IS_MACOS = false

    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    expect(
      screen.getByText('settings:general.showInFileExplorer')
    ).toBeInTheDocument()
  })

  it('should disable check for updates button when checking', async () => {
    // Create a promise that we can control
    let resolveUpdate: (value: any) => void
    const updatePromise = new Promise((resolve) => {
      resolveUpdate = resolve
    })
    mockCheckForUpdateNow.mockReturnValue(updatePromise)

    const Component = GeneralRoute.component as React.ComponentType
    await act(async () => {
      render(<Component />)
    })

    const buttons = screen.getAllByTestId('button')
    const checkUpdateButton = buttons.find((button) =>
      button.textContent?.includes('checkForUpdates')
    )

    if (checkUpdateButton) {
      // Click the button but don't await it yet
      act(() => {
        fireEvent.click(checkUpdateButton)
      })

      // Now the button should be disabled while checking
      expect(checkUpdateButton).toBeDisabled()

      // Resolve the promise to finish the update check
      await act(async () => {
        resolveUpdate!({ status: 'up-to-date' })
        await updatePromise
      })

      // Button should be enabled again
      expect(checkUpdateButton).not.toBeDisabled()
    }
  })
})
