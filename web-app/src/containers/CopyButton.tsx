import { Button } from '@/components/ui/button'
import { IconCopy, IconCopyCheck } from '@tabler/icons-react'
import { useState } from 'react'
import { copyToClipboard } from '@/lib/clipboard'

export const CopyButton = ({
  text,
  ariaLabel,
  onCopied,
}: {
  text: string
  /** Names the button when several sit next to each other. */
  ariaLabel?: string
  /** Runs only after the text actually reached the clipboard. */
  onCopied?: () => void
}) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    // Only claim success once the write actually landed — a denied clipboard
    // used to leave the checkmark showing over a clipboard that never changed.
    if (!(await copyToClipboard(text))) return
    setCopied(true)
    onCopied?.()
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={handleCopy}
      aria-label={ariaLabel}
    >
      {copied ? (
        <>
          <IconCopyCheck size={16} className="text-primary" />
        </>
      ) : (
        <IconCopy size={16} />
      )}
    </Button>
  )
}
