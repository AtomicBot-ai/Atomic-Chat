import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AttachmentPreviewDialog,
  TEXT_PREVIEW_MAX_BYTES,
} from '../AttachmentPreviewDialog'
import { AttachmentChip } from '../AttachmentChip'
import { seedServiceHub } from '@/test/service-hub'
import type { RAGService } from '@/services/rag/types'
import type { OpenerService } from '@/services/opener/types'

const mocks = vi.hoisted(() => ({
  fileStat: vi.fn(),
  readFileHead: vi.fn(),
  parseDocument: vi.fn(),
  openPath: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
}))

vi.mock('@janhq/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@janhq/core')>()),
  fs: { fileStat: mocks.fileStat },
}))

vi.mock('@/lib/readFileBytes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/readFileBytes')>()),
  readFileHead: mocks.readFileHead,
}))

vi.mock('@/lib/platform/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/utils')>()),
  isPlatformTauri: () => true,
}))

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'path' in options ? `${key} ${options.path}` : key,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fileStat.mockResolvedValue({ isDirectory: false, size: 12 })
  seedServiceHub({
    rag: { parseDocument: mocks.parseDocument } as unknown as RAGService,
    opener: {
      openPath: mocks.openPath,
      revealItemInDir: mocks.revealItemInDir,
    } as unknown as OpenerService,
  })
})

const encode = (text: string) => new TextEncoder().encode(text)

describe('AttachmentPreviewDialog', () => {
  it('renders nothing without a source', () => {
    render(<AttachmentPreviewDialog source={null} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows an in-memory image without touching the disk', async () => {
    render(
      <AttachmentPreviewDialog
        source={{
          name: 'cat.png',
          url: 'data:image/png;base64,AAAA',
          mimeType: 'image/png',
        }}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByRole('img', { name: 'cat.png' })).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAA'
    )
    expect(mocks.fileStat).not.toHaveBeenCalled()
    // Nothing on disk to open.
    expect(screen.queryByText('attachmentPreview.open')).toBeNull()
  })

  it('reads the head of a text file and says when it is cut', async () => {
    mocks.readFileHead.mockResolvedValue({
      bytes: encode('fn main() {}'),
      size: TEXT_PREVIEW_MAX_BYTES * 2,
      truncated: true,
    })

    render(
      <AttachmentPreviewDialog
        source={{ name: 'main.rs', path: '/src/main.rs', fileType: 'rs' }}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByText('fn main() {}')).toBeInTheDocument()
    expect(screen.getByText('attachmentPreview.truncated')).toBeInTheDocument()
    expect(mocks.readFileHead).toHaveBeenCalledWith(
      '/src/main.rs',
      TEXT_PREVIEW_MAX_BYTES
    )
  })

  it('shows the text parsed out of an office document', async () => {
    mocks.parseDocument.mockResolvedValue('Quarterly plan')

    render(
      <AttachmentPreviewDialog
        source={{
          name: 'plan.docx',
          path: '/docs/plan.docx',
          fileType: 'docx',
        }}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByText('Quarterly plan')).toBeInTheDocument()
    expect(screen.getByText('attachmentPreview.extracted')).toBeInTheDocument()
    expect(mocks.parseDocument).toHaveBeenCalledWith('/docs/plan.docx', 'docx')
  })

  it('reuses text extracted when the document was attached', async () => {
    render(
      <AttachmentPreviewDialog
        source={{
          name: 'plan.docx',
          path: '/docs/plan.docx',
          inlineContent: 'Already parsed',
        }}
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByText('Already parsed')).toBeInTheDocument()
    expect(mocks.parseDocument).not.toHaveBeenCalled()
  })

  it('plays a video from the asset protocol', async () => {
    const { baseElement } = render(
      <AttachmentPreviewDialog
        source={{ name: 'demo.mp4', path: '/movies/demo.mp4' }}
        onClose={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(baseElement.querySelector('video')).toHaveAttribute(
        'src',
        'asset://localhost/movies/demo.mp4'
      )
    )
  })

  it('says so when the file has moved', async () => {
    mocks.fileStat.mockResolvedValue(undefined)

    render(
      <AttachmentPreviewDialog
        source={{ name: 'report.pdf', path: '/gone/report.pdf' }}
        onClose={vi.fn()}
      />
    )

    expect(
      await screen.findByText('attachmentPreview.missing /gone/report.pdf')
    ).toBeInTheDocument()
  })

  it('offers the file’s own app for what it cannot preview', async () => {
    render(
      <AttachmentPreviewDialog
        source={{ name: 'notes.zip', path: '/tmp/notes.zip' }}
        onClose={vi.fn()}
      />
    )

    expect(
      screen.getByText('attachmentPreview.unsupported')
    ).toBeInTheDocument()
    fireEvent.click(screen.getAllByText('attachmentPreview.open')[0])
    expect(mocks.openPath).toHaveBeenCalledWith('/tmp/notes.zip')
    fireEvent.click(
      screen.getByRole('button', { name: 'attachmentPreview.showInFolder' })
    )
    expect(mocks.revealItemInDir).toHaveBeenCalledWith('/tmp/notes.zip')
  })
})

/** A chip wired to the dialog the way the composer and messages wire it. */
function ChipWithPreview({
  onRemove,
  isProcessing,
}: {
  onRemove?: () => void
  isProcessing?: boolean
}) {
  const [source, setSource] = useState<{ name: string; path: string } | null>(
    null
  )
  return (
    <>
      <AttachmentChip
        name="notes.zip"
        isProcessing={isProcessing}
        onOpen={() => setSource({ name: 'notes.zip', path: '/tmp/notes.zip' })}
        onRemove={onRemove}
      />
      <AttachmentPreviewDialog
        source={source}
        onClose={() => setSource(null)}
      />
    </>
  )
}

describe('AttachmentChip', () => {
  it('opens the preview on click', async () => {
    render(<ChipWithPreview />)

    fireEvent.click(screen.getByRole('button', { name: 'notes.zip' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'attachmentPreview.unsupported'
    )
  })

  it('opens the preview from the keyboard', async () => {
    render(<ChipWithPreview />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'notes.zip' }), {
      key: 'Enter',
    })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('is not a button without a preview, or while it is processing', () => {
    const { rerender } = render(<AttachmentChip name="report.pdf" />)
    expect(screen.queryByRole('button', { name: 'report.pdf' })).toBeNull()

    rerender(<AttachmentChip name="report.pdf" isProcessing onOpen={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'report.pdf' })).toBeNull()
  })

  it('keeps remove from opening the preview', () => {
    const onRemove = vi.fn()
    render(<ChipWithPreview onRemove={onRemove} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
