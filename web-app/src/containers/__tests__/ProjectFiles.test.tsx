import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServiceHub } from '@/services'
import { seedServiceHub } from '@/test/service-hub'
import { useAttachments } from '@/hooks/useAttachments'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { useProjectUploads } from '@/stores/project-upload-store'

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
    // In-flight uploads outlive the component; a never-settling ingest from
    // an earlier test would otherwise still be running.
    useProjectUploads.setState({ inFlight: {}, revision: {} })
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

  it('treats an uninitialized project database as an empty project', async () => {
    mocks.listAttachmentsForProject.mockRejectedValue({
      DatabaseError: 'no such table: files',
    })
    seedServiceHub()

    render(<ProjectFiles projectId="new-project" lng="en" />)

    await waitFor(() =>
      expect(screen.getByText('common:projects.filesDescription')).toBeTruthy()
    )
    expect(screen.queryByRole('alert')).toBeNull()
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

  // AC-09: the first upload downloads the embedding model before it indexes
  // anything. Leaving the project in that window used to drop the indexing
  // indicator, and the list refresh at the end landed on the unmounted page,
  // so Files stayed empty until the next visit.
  it('keeps an upload indexing across leaving the page and lists the file when it lands', async () => {
    let finishIngest: (result: { id: string }) => void = () => {}
    const ingest = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finishIngest = resolve
        })
    )
    const indexed: Array<Record<string, unknown>> = []
    mocks.listAttachmentsForProject.mockImplementation(async () => [...indexed])
    seedServiceHub({
      dialog: {
        open: vi.fn().mockResolvedValue(['/tmp/table.csv']),
      } as unknown as ReturnType<ServiceHub['dialog']>,
      uploads: {
        ingestFileAttachmentForProject: ingest,
      } as unknown as ReturnType<ServiceHub['uploads']>,
    })

    const firstVisit = render(<ProjectFiles projectId="p1" lng="en" />)
    await screen.findByText('common:projects.filesDescription')
    fireEvent.click(screen.getByRole('button', { name: /upload/i }))
    await waitFor(() => expect(ingest).toHaveBeenCalledOnce())
    act(() => {
      useDownloadStore
        .getState()
        .updateProgress(EMBEDDING_MODEL_ID, 0.5, EMBEDDING_MODEL_ID, 50, 100)
    })

    // Navigate away while the embedding model downloads, then come back.
    firstVisit.unmount()
    render(<ProjectFiles projectId="p1" lng="en" />)

    const button = await screen.findByRole('button', {
      name: 'common:projects.uploading',
    })
    expect(button).toBeDisabled()
    expect(screen.getByRole('status').textContent).toContain(
      'common:projects.preparingIndexModel'
    )
    expect(
      screen.getByText('common:projects.uploadingHint').parentElement
    ).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByText('table.csv')).toBeNull()

    // Indexing finishes while this second visit is on screen.
    indexed.push({
      id: 'file-1',
      name: 'table.csv',
      path: '/tmp/table.csv',
      type: 'csv',
      size: 74,
      chunk_count: 1,
    })
    act(() => {
      useDownloadStore.setState({ downloads: {} })
    })
    await act(async () => finishIngest({ id: 'file-1' }))

    expect(await screen.findByText('table.csv')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /upload/i })).toBeEnabled()
    expect(screen.getByRole('status').textContent).toBe('')
    expect(useProjectUploads.getState().inFlight).toEqual({})
  })
})
