import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConnectorCard } from '../ConnectorCard'
import { MCP_CONNECTORS } from '@/constants/mcp-connectors'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}))

const exa = MCP_CONNECTORS.find((c) => c.serverKey === 'exa')!
const linear = MCP_CONNECTORS.find((c) => c.serverKey === 'linear')!
const github = MCP_CONNECTORS.find((c) => c.serverKey === 'github')!

/** The card header contains identity and state-specific actions. */
const bandsOf = (name: string) => {
  const card = screen
    .getByRole('heading', { name })
    .closest('div.bg-card') as HTMLElement
  return {
    card,
    header: card.firstElementChild as HTMLElement,
  }
}

const follows = (first: Element, second: Element) =>
  Boolean(
    first.compareDocumentPosition(second) & document.DOCUMENT_POSITION_FOLLOWING
  )

describe('ConnectorCard anatomy', () => {
  it('puts Set Up at the top-right: in the header row, after the 40 px tile and the name', () => {
    render(<ConnectorCard connector={exa} busy={false} onSetUp={vi.fn()} />)

    const { header } = bandsOf('Exa')
    const setUp = screen.getByRole('button', { name: 'mcp-connectors:setUp' })
    expect(header).toContainElement(
      screen.getByRole('heading', { name: 'Exa' })
    )
    expect(header).toContainElement(setUp)
    // The description reads after the primary action, never above it.
    expect(
      follows(setUp, screen.getByText('mcp-connectors:descriptions.exa'))
    ).toBe(true)
    expect(screen.getByRole('img', { name: 'Exa' }).parentElement).toHaveClass(
      'size-10'
    )
  })

  it('puts Sign in in the header of an oauth card, and Cancel there while the browser sign-in is pending', async () => {
    const user = userEvent.setup()
    const onCancelSignIn = vi.fn()
    const { rerender } = render(
      <ConnectorCard
        connector={linear}
        busy={false}
        onSetUp={vi.fn()}
        onCancelSignIn={onCancelSignIn}
      />
    )
    expect(bandsOf('Linear').header).toContainElement(
      screen.getByRole('button', { name: 'mcp-connectors:oauth.signIn' })
    )

    rerender(
      <ConnectorCard
        connector={linear}
        busy
        onSetUp={vi.fn()}
        onCancelSignIn={onCancelSignIn}
      />
    )
    const cancel = screen.getByRole('button', {
      name: 'mcp-connectors:oauth.cancel',
    })
    expect(bandsOf('Linear').header).toContainElement(cancel)
    expect(
      screen.queryByRole('button', { name: 'mcp-connectors:oauth.signIn' })
    ).not.toBeInTheDocument()
    await user.click(cancel)
    expect(onCancelSignIn).toHaveBeenCalledTimes(1)
  })

  it('keeps the disabled Sign in of an oauth-soon connector in the header', () => {
    render(<ConnectorCard connector={github} busy={false} />)

    const signIn = screen.getByRole('button', {
      name: 'mcp-connectors:oauth.signIn',
    })
    expect(signIn).toBeDisabled()
    expect(bandsOf('GitHub').header).toContainElement(signIn)
  })

  it.each([exa, linear, github])(
    'shows only the primary action before $name is configured',
    (connector) => {
      render(<ConnectorCard connector={connector} busy={false} />)
      expect(screen.getAllByRole('button')).toHaveLength(1)
      expect(screen.queryByRole('switch')).not.toBeInTheDocument()
      expect(
        screen.queryByText('mcp-connectors:statusNotSetUp')
      ).not.toBeInTheDocument()
      expect(
        screen.queryByTitle('mcp-connectors:serverActions')
      ).not.toBeInTheDocument()
    }
  )

  it.each([
    { active: true, state: 'connected', label: 'connected' },
    { active: false, state: 'connected', label: 'statusInactive' },
    { active: false, state: 'error', label: 'statusInactive' },
    { active: true, state: 'error', label: 'statusError' },
    { active: true, state: undefined, label: 'statusInactive' },
  ] as const)(
    'configured Exa: active=$active runtime=$state keeps status under its identity and controls together',
    ({ active, state, label }) => {
      render(
        <ConnectorCard
          connector={exa}
          installed={{ key: 'exa', config: { ...exa.config, active } }}
          status={
            state
              ? { name: 'exa', status: state, error: 'Connection refused' }
              : undefined
          }
          busy={false}
        />
      )
      const { header } = bandsOf('Exa')
      const title = screen.getByRole('heading', { name: 'Exa' })
      const byline = screen.getByText('mcp-connectors:by:Exa')
      const status = screen.getByText(`mcp-connectors:${label}`)
      expect(header).toContainElement(status)
      expect(follows(title, byline) && follows(byline, status)).toBe(true)
      const actions = screen.getByTitle('mcp-connectors:serverActions')
        .parentElement as HTMLElement
      expect(
        within(actions).getByTitle('mcp-connectors:serverActions')
      ).toBeEnabled()
      const toggle = within(actions).getByRole('switch')
      expect(toggle).toBeEnabled()
      expect(toggle).toHaveAttribute('aria-checked', String(active))
      expect(screen.queryByText('mcp-connectors:setUp')).not.toBeInTheDocument()
      expect(
        screen.queryByText('mcp-connectors:statusNotSetUp')
      ).not.toBeInTheDocument()
      if (active && state === 'error')
        expect(status).toHaveAttribute('title', 'Connection refused')
    }
  )

  it('toggles a configured inactive connector and retains its management menu', async () => {
    function StatefulCard() {
      const [active, setActive] = useState(false)
      return (
        <ConnectorCard
          connector={exa}
          installed={{ key: 'exa', config: { ...exa.config, active } }}
          busy={false}
          onToggle={setActive}
          onTools={() => {}}
        />
      )
    }
    const user = userEvent.setup()
    render(<StatefulCard />)
    await user.click(screen.getByRole('switch'))
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByTitle('mcp-connectors:serverActions'))
    for (const name of [
      'mcp-servers:editServer',
      'mcp-connectors:editJson',
      'mcp-connectors:tools',
      'mcp-servers:deleteServer.title',
    ]) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument()
    }
  })

  it('preserves setup busy state and configured loading state', () => {
    const { rerender } = render(<ConnectorCard connector={exa} busy />)
    expect(
      screen.getByRole('button', { name: 'mcp-connectors:setUp' })
    ).toBeDisabled()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    rerender(
      <ConnectorCard
        connector={exa}
        installed={{ key: 'exa', config: { ...exa.config, active: false } }}
        busy
      />
    )
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch')).toBeDisabled()
  })

  it.each([exa, linear])(
    'preserves the $name setup flow into a configured card',
    async (connector) => {
      function SetupFlow() {
        const [configured, setConfigured] = useState(false)
        return (
          <ConnectorCard
            connector={connector}
            installed={
              configured
                ? {
                    key: connector.serverKey,
                    config: { ...connector.config, active: true },
                  }
                : undefined
            }
            busy={false}
            onSetUp={() => setConfigured(true)}
          />
        )
      }
      render(<SetupFlow />)
      await userEvent.setup().click(screen.getByRole('button'))
      expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
      expect(
        screen.getByTitle('mcp-connectors:serverActions')
      ).toBeInTheDocument()
      expect(
        screen.queryByText('mcp-connectors:oauth.signIn')
      ).not.toBeInTheDocument()
      expect(screen.queryByText('mcp-connectors:setUp')).not.toBeInTheDocument()
    }
  )

  it('keeps hand-added servers configured and masks their URL credentials', () => {
    render(
      <ConnectorCard
        installed={{
          key: 'private-search',
          config: {
            type: 'http',
            url: 'https://example.com/mcp?api_key=secret',
            active: false,
          },
        }}
        busy={false}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'private-search' })
    ).toBeInTheDocument()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(
      screen.getByText('mcp-connectors:statusInactive')
    ).toBeInTheDocument()
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument()
  })

  it('fills its grid cell across a row', () => {
    render(<ConnectorCard connector={exa} busy={false} />)

    expect(bandsOf('Exa').card).toHaveClass('h-full', 'flex', 'flex-col')
  })

  it("ships Linear's current logomark from linear.app/brand", () => {
    render(<ConnectorCard connector={linear} busy={false} />)

    const img = screen.getByRole('img', { name: 'Linear' })
    expect(img).toHaveAttribute('src', '/images/connectors/linear.svg')
    const svg = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'public',
        'images',
        'connectors',
        'linear.svg'
      ),
      'utf8'
    )
    // The logomark on linear.app/brand opens its path at (12.927, 16.371) in
    // a 100-unit box; the retired mark (Simple Icons' 24-unit drawing) opened
    // at (2.886, 4.18).
    expect(svg).toContain('M12.927 16.371')
    expect(svg).not.toContain('M2.886 4.18')
    expect(svg).toContain('fill="#fff"')
  })
})
