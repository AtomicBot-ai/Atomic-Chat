import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  extractFilesFromPrompt,
  injectFilesIntoPrompt,
} from '@/lib/fileMetadata'

interface InlineMessageEditorProps {
  /**
   * Raw message text, i.e. exactly what the transcript stores — the
   * `[ATTACHED_FILES]` block included. It is stripped for editing and
   * re-injected on save so attachments survive an edit.
   */
  initialText: string
  onSave: (newText: string) => void
  onCancel: () => void
  className?: string
}

/**
 * In-place message editor: the message text turns into a textarea where it
 * sits in the transcript, instead of opening a modal over a blurred thread.
 *
 * Enter saves, Shift+Enter adds a newline, Escape cancels — the same contract
 * as the composer below it.
 */
export function InlineMessageEditor({
  initialText,
  onSave,
  onCancel,
  className,
}: InlineMessageEditorProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Document attachments are encoded inside the message text rather than as
  // separate parts, so they have to be split off before editing and put back
  // on save.
  const { files, cleanPrompt } = useMemo(
    () => extractFilesFromPrompt(initialText),
    [initialText]
  )
  const [draft, setDraft] = useState(cleanPrompt)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    // Caret at the end rather than a full selection: the common case is
    // amending the message, not replacing it wholesale.
    const end = textarea.value.length
    textarea.setSelectionRange(end, end)
  }, [])

  const finalMessage = useMemo(
    () => injectFilesIntoPrompt(draft.trim(), files),
    [draft, files]
  )
  const canSave = draft.trim().length > 0 && finalMessage !== initialText

  const handleSave = useCallback(() => {
    if (!draft.trim()) return
    // A no-op save is a cancel. It matters: saving a user message deletes
    // every later message in the thread and re-runs the model.
    if (finalMessage === initialText) {
      onCancel()
      return
    }
    onSave(finalMessage)
  }, [draft, finalMessage, initialText, onCancel, onSave])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // The app's global shortcuts listen on `window` with no focused-input
      // guard, so typing Cmd+N / Cmd+K here would otherwise start a new chat
      // or open search.
      e.stopPropagation()

      // e.keyCode 229 is for IME input with Safari
      const isComposing = e.nativeEvent.isComposing || e.keyCode === 229

      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }

      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave, onCancel]
  )

  return (
    <div className={cn('flex w-full flex-col gap-2', className)}>
      {/* The border is what tells the reader they are in edit mode — without
          it an inline editor is indistinguishable from the rendered message. */}
      <TextareaAutosize
        dir="auto"
        ref={textareaRef}
        value={draft}
        minRows={1}
        maxRows={12}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label={t('common:editMessage')}
        data-testid="inline-message-editor"
        className="border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-base outline-none focus-visible:ring-[3px] md:text-sm wrap-anywhere"
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common:cancel')}
        </Button>
        <Button size="sm" disabled={!canSave} onClick={handleSave}>
          {t('common:save')}
        </Button>
      </div>
    </div>
  )
}
