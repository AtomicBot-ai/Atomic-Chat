import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConnectorCard } from '../ConnectorCard'
import { MCP_CONNECTORS } from '@/constants/mcp-connectors'
import type { MCPServerStatus } from '@/services/mcp/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}))

const exa = MCP_CONNECTORS.find((c) => c.serverKey === 'exa')!
const linear = MCP_CONNECTORS.find((c) => c.serverKey === 'linear')!
const github = MCP_CONNECTORS.find((c) => c.serverKey === 'github')!

/** The card's three bands, top to bottom: header row, description, footer. */
const bandsOf = (name: string) => {
  const card = screen
    .getByRole('heading', { name })
    .closest('div.bg-card') as HTMLElement
  return {
    card,
    header: card.firstElementChild as HTMLElement,
    footer: card.lastElementChild as HTMLElement,
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
    // Right edge: the action cluster is the last thing in the header row...
    expect(header.lastElementChild).toContainElement(setUp)
    // ...and the description reads after it, never above it.
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

  it('gives a card that is not set up the same footer as an installed one: a muted "Not set up" pill and a toggle that is off and disabled', () => {
    render(<ConnectorCard connector={exa} busy={false} onSetUp={vi.fn()} />)

    const { footer } = bandsOf('Exa')
    expect(
      within(footer).getByText('mcp-connectors:statusNotSetUp')
    ).toBeInTheDocument()
    const toggle = within(footer).getByRole('switch')
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(footer).toHaveClass('min-h-8')
    // Nothing dangles bottom-right: the footer holds no action button.
    expect(within(footer).queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps the menu at the top-right and the status + live toggle in the footer once installed', () => {
    render(
      <ConnectorCard
        connector={exa}
        installed={{ key: 'exa', config: { ...exa.config, active: true } }}
        status={{ status: 'connected' } as MCPServerStatus}
        busy={false}
        onToggle={vi.fn()}
        onEdit={vi.fn()}
        onEditJson={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    const { header, footer } = bandsOf('Exa')
    expect(header).toContainElement(
      screen.getByTitle('mcp-connectors:serverActions')
    )
    expect(
      screen.queryByRole('button', { name: 'mcp-connectors:setUp' })
    ).not.toBeInTheDocument()
    expect(
      within(footer).getByText('mcp-connectors:connected')
    ).toBeInTheDocument()
    const toggle = within(footer).getByRole('switch')
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(footer).toHaveClass('min-h-8')
  })

  it('fills its grid cell so footers line up across a row', () => {
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
