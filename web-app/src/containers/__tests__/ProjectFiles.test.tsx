import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServiceHub } from '@/services'
import { seedServiceHub } from '@/test/service-hub'
import { useAttachments } from '@/hooks/useAttachments'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { EMBEDDING_MODEL_ID } from '@/constants/models'

const mocks = vi.hoisted(() => ({
  listAttachmentsForProject: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      get: () => ({
        listAttachmentsForProject: mocks.listAttachmentsForProject,
      }),
    }),
  },
}))

vi.mock('@janhq/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@janhq/core')>()
  return {
    ...actual,
    fs: {
      ...actual.fs,
      fileStat: async () => ({ isDirectory: false, size: 128 }),
    },
  }
})

import ProjectFiles from '../ProjectFiles'

describe('ProjectFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAttachments.setState({ enabled: true, maxFileSizeMB: 50 })
    useDownloadStore.setState({ downloads: {} })
    mocks.listAttachmentsForProject.mockResolvedValue([])
  })

  it('tells the user what an upload is waiting on instead of spinning silently', async () => {
    seedServiceHub({
      dialog: {
        open: vi.fn().mockResolvedValue(['/tmp/notes.txt']),
      } as unknown as ReturnType<ServiceHub['dialog']>,
      uploads: {
        // The ingest that downloads and loads the embedding model first.
        ingestFileAttachmentForProject: vi.fn(() => new Promise(() => {})),
      } as unknown as ReturnType<ServiceHub['uploads']>,
    })

    render(<ProjectFiles projectId="p1" lng="en" />)
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeTruthy()
    )

    fireEvent.click(screen.getByRole('button', { name: /upload/i }))

    // The button itself says the upload is indexing (#289); the live region
    // stays empty until there is a download to report.
    await screen.findByText('common:projects.uploading')
    expect(screen.getByRole('status').textContent).toBe('')

    act(() => {
      useDownloadStore
        .getState()
        .updateProgress(EMBEDDING_MODEL_ID, 0.43, EMBEDDING_MODEL_ID, 43, 100)
    })

    await waitFor(() => {
      const text = screen.getByRole('status').textContent ?? ''
      expect(text).toContain('common:projects.preparingIndexModel')
      expect(text).toContain('43%')
    })

    // A download whose size the server did not report has no usable ratio:
    // name the download, skip the number.
    act(() => {
      useDownloadStore
        .getState()
        .updateProgress(EMBEDDING_MODEL_ID, Infinity, EMBEDDING_MODEL_ID, 10, 0)
    })
    await waitFor(() => {
      const text = screen.getByRole('status').textContent ?? ''
      expect(text).toContain('common:projects.preparingIndexModel')
      expect(text).not.toContain('%')
    })
  })

  it('reports a failed file listing instead of showing an empty project', async () => {
    mocks.listAttachmentsForProject.mockRejectedValue({
      error: { message: 'database is locked' },
    })
    seedServiceHub()

    render(<ProjectFiles projectId="p1" lng="en" />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('common:projects.filesLoadFailed')
    expect(alert.textContent).toContain('database is locked')
    expect(screen.queryByText('common:projects.filesDescription')).toBeNull()

    mocks.listAttachmentsForProject.mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: 'common:retry' }))
    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeTruthy()
    )
  })

  it('waits for the attachments extension instead of flashing an error', async () => {
    useAttachments.setState({ enabled: false })
    seedServiceHub()

    render(<ProjectFiles projectId="p1" lng="en" />)

    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeTruthy()
    )
    expect(mocks.listAttachmentsForProject).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()

    act(() => useAttachments.setState({ enabled: true }))
    await waitFor(() =>
      expect(mocks.listAttachmentsForProject).toHaveBeenCalledWith('p1')
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uploads a file and refreshes the visible project list', async () => {
    const ingest = vi.fn().mockResolvedValue({ id: 'file-1' })
    mocks.listAttachmentsForProject
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: 'file-1',
          name: 'notes.txt',
          path: '/tmp/notes.txt',
          type: 'txt',
          size: 128,
          chunk_count: 1,
        },
      ])
    seedServiceHub({
      dialog: {
        open: vi.fn().mockResolvedValue(['/tmp/notes.txt']),
      } as unknown as ReturnType<ServiceHub['dialog']>,
      uploads: {
        ingestFileAttachmentForProject: ingest,
      } as unknown as ReturnType<ServiceHub['uploads']>,
    })

    render(<ProjectFiles projectId="p1" lng="en" />)
    await screen.findByText('common:projects.filesDescription')
    fireEvent.click(screen.getByRole('button', { name: /upload/i }))

    await waitFor(() => expect(ingest).toHaveBeenCalledOnce())
    expect(await screen.findByText('notes.txt')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
