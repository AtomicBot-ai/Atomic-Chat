import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MCPLogViewer } from '../MCPLogViewer'
import type { ServiceHub } from '@/services'
import { TauriAppService } from '@/services/app/tauri'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const originalTz = process.env.TZ

afterEach(() => {
  process.env.TZ = originalTz
})

async function renderWith(lines: string[], emitted?: string) {
  const appService = new TauriAppService()
  let onLog: ((event: unknown) => void) | undefined
  seedServiceHub({
    app: {
      readLogs: vi.fn().mockResolvedValue(lines.map(appService.parseLogLine)),
      parseLogLine: appService.parseLogLine,
    } as unknown as ReturnType<ServiceHub['app']>,
    events: {
      listen: vi.fn(
        async (_name: string, handler: (event: unknown) => void) => {
          onLog = handler
          return () => {}
        }
      ),
    } as unknown as ReturnType<ServiceHub['events']>,
  })
  await act(async () => {
    render(<MCPLogViewer />)
  })
  if (emitted) {
    await act(async () => {
      onLog?.({ payload: { message: emitted } })
    })
  }
}

describe('MCPLogViewer', () => {
  it('shows times as YYYY-MM-DD HH:MM:SS UTC, as written in app.log', async () => {
    process.env.TZ = 'Europe/Moscow'

    await renderWith(
      [
        '[2026-09-28][12:00:05][app_lib::core::mcp::helpers][INFO] Starting MCP server fs',
      ],
      '[2026-09-28][12:00:06][app_lib::core::mcp::helpers][WARN] MCP server fs restarted'
    )

    expect(screen.getByText('[2026-09-28 12:00:05 UTC]')).toBeInTheDocument()
    expect(screen.getByText('[2026-09-28 12:00:06 UTC]')).toBeInTheDocument()
    expect(screen.getByText('Starting MCP server fs')).toBeInTheDocument()
  })

  it('shows only MCP targets', async () => {
    await renderWith([
      '[2026-09-28][12:00:05][app_lib::core::setup][INFO] not MCP',
      '[2026-09-28][12:00:05][app_lib::core::mcp::commands][INFO] MCP line',
    ])

    expect(screen.queryByText('not MCP')).not.toBeInTheDocument()
    expect(screen.getByText('MCP line')).toBeInTheDocument()
  })
})
