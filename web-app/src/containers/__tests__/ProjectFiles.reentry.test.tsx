import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import ProjectFiles from '../ProjectFiles'

const openDialog = vi.fn()
const ingest = vi.fn()

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    dialog: () => ({ open: openDialog }),
    uploads: () => ({ ingestFileAttachmentForProject: ingest }),
  }),
}))

vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: (selector: (s: { enabled: boolean; maxFileSizeMB: number }) => unknown) =>
    selector({ enabled: true, maxFileSizeMB: 100 }),
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      // No indexed files yet, so the duplicate filter has nothing to match on —
      // the in-flight guard is the only thing that can stop a second ingest.
      get: () => ({ listAttachmentsForProject: vi.fn().mockResolvedValue([]) }),
    }),
  },
}))

vi.mock('@janhq/core', () => ({
  ExtensionTypeEnum: { VectorDB: 'vectorDB' },
  fs: { fileStat: vi.fn().mockResolvedValue({ isDirectory: false, size: 10 }) },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

/**
 * ATO — #289: only the Upload *button* was gated by `uploading`. The large
 * dashed drop area next to it was not, and the duplicate filter only knew
 * about files that were already indexed — so a second click during an ingest
 * started a concurrent one. Both derive the same download task id for the
 * embedding model, so the second cancelled the first, and with an unreachable
 * host in the way the pair never converged.
 */
describe('ProjectFiles re-entry while an upload is in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openDialog.mockResolvedValue(['/tmp/notes.md'])
    // Never settles: models the embedding-model download grinding through its
    // retry ladders.
    ingest.mockReturnValue(new Promise(() => {}))
  })

  it('ignores a second dropzone click while the first ingest is running', async () => {
    const user = userEvent.setup()
    render(<ProjectFiles projectId="p1" lng="en" />)

    const dropzone = await screen.findByText('common:projects.filesDescription')

    await user.click(dropzone)
    await waitFor(() => expect(ingest).toHaveBeenCalledTimes(1))

    // The dropzone is still on screen (now showing the indexing hint); clicking
    // it again must not start a second run.
    await user.click(
      screen.getByText('common:projects.uploadingHint').parentElement!
    )
    await user.click(screen.getByText('common:projects.uploading'))

    expect(openDialog).toHaveBeenCalledTimes(1)
    expect(ingest).toHaveBeenCalledTimes(1)
  })

  it('marks the dropzone as disabled so the state is visible, not just inert', async () => {
    const user = userEvent.setup()
    render(<ProjectFiles projectId="p1" lng="en" />)

    const dropzone = await screen.findByText('common:projects.filesDescription')
    expect(dropzone.parentElement).toHaveAttribute('aria-disabled', 'false')

    await user.click(dropzone)

    await waitFor(() =>
      expect(
        screen.getByText('common:projects.uploadingHint').parentElement
      ).toHaveAttribute('aria-disabled', 'true')
    )
  })
})
