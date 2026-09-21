import { Button } from '@/components/ui/button'
import { IconCopy, IconCopyCheck } from '@tabler/icons-react'
import { useState } from 'react'
import { copyToClipboard } from '@/lib/clipboard'

export const CopyButton = ({
  text,
  ariaLabel,
  label,
  className,
}: {
  text: string
  ariaLabel?: string
  label?: string
  className?: string
}) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    // Only claim success once the write actually landed — a denied clipboard
    // used to leave the checkmark showing over a clipboard that never changed.
    if (!(await copyToClipboard(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      variant={label ? 'outline' : 'ghost'}
      size={label ? 'sm' : 'icon-xs'}
      className={className}
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
      {label && <span className="min-w-0 truncate">{label}</span>}
    </Button>
  )
}
