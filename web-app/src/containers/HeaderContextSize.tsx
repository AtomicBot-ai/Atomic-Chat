import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { ContextSizeControl } from '@/containers/ContextSizeControl'
import {
  NEW_THREAD_ATTACHMENT_KEY,
  useChatAttachments,
} from '@/hooks/useChatAttachments'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { cn } from '@/lib/utils'
import { useHeaderOverlay } from '@/stores/header-overlay-store'

const imageMimeFromName = (fileName: string): string => {
  switch (fileName.toLowerCase().split('.').pop()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    default:
      return ''
  }
}

/**
 * The context gauge as it sits in the page header, top right. It reads the
 * thread and its pending image attachments itself so every chat route can drop
 * it in without threading composer state up through the layout — the composer
 * no longer carries it. Renders nothing for providers with no context knob of
 * their own (the control decides that).
 */
const HeaderContextSize = memo(function HeaderContextSize() {
  const currentThreadId = useThreads((state) => state.currentThreadId)
  const messages = useMessages(
    useShallow((state) =>
      currentThreadId ? state.messages[currentThreadId] : []
    )
  )
  const attachments = useChatAttachments(
    useCallback(
      (state) =>
        state.getAttachments(currentThreadId ?? NEW_THREAD_ATTACHMENT_KEY),
      [currentThreadId]
    )
  )

  const uploadedFiles = useMemo(
    () =>
      attachments
        .filter((a) => a.type === 'image' && a.dataUrl)
        .map((a) => ({
          name: a.name,
          type: a.mimeType || imageMimeFromName(a.name),
          size: a.size || 0,
          base64: a.base64 || '',
          dataUrl: a.dataUrl!,
        })),
    [attachments]
  )

  // Clears the floating "open files" button (32px wide, 12px off the window
  // edge) whenever the agent workspace paints one over this corner.
  const rightOverlay = useHeaderOverlay((state) => state.rightOverlay)

  return (
    <div className={cn('shrink-0', rightOverlay && 'mr-10')}>
      <ContextSizeControl
        messages={messages || []}
        uploadedFiles={uploadedFiles}
      />
    </div>
  )
})

export default HeaderContextSize
