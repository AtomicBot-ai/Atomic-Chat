import { useCallback, useState } from 'react'
import type { FitLevel } from '@/containers/SetupScreenHelpers'

/**
 * A download asked for on a row whose fit mark is red: the file will come
 * down, and the model will not load on this machine.
 */
export type WontFitDownload = {
  /** The model as the row names it. */
  name: string
  /** The row's fit sentence, in the machine's own figures, if it has one. */
  reason: string | null
  /** Starts the download exactly as the button would have. */
  start: () => void
}

/** What the guard reads off a row before letting its Download through. */
export type WontFitGuardRow = Pick<WontFitDownload, 'name' | 'reason'> & {
  /** The row's fit colour; only red (`no`) asks. */
  level: FitLevel | null
}

/** What `ConfirmWontFitDownload` renders from. */
export type WontFitConfirmation = {
  open: boolean
  /** Kept through the closing animation so the copy does not blank out. */
  download: WontFitDownload | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * The one guard both download lists call: `guardWontFit(row, start)` starts
 * at once unless the row is red, in which case it asks first — through a
 * `ConfirmWontFitDownload` rendered once from `confirmation` — and starts on
 * "Download anyway". Cancel, Escape and the close button start nothing.
 *
 * Yellow rows are not asked: a model that runs tight or spills into system
 * RAM still runs, and the mark's sentence already says how. Asking there
 * would cry wolf on the machines where most downloads are yellow.
 */
export function useConfirmWontFitDownload(): {
  guardWontFit: (row: WontFitGuardRow, start: () => void) => void
  confirmation: WontFitConfirmation
} {
  const [open, setOpen] = useState(false)
  const [download, setDownload] = useState<WontFitDownload | null>(null)

  const guardWontFit = useCallback(
    (row: WontFitGuardRow, start: () => void) => {
      if (row.level !== 'no') {
        start()
        return
      }
      setDownload({ name: row.name, reason: row.reason, start })
      setOpen(true)
    },
    []
  )

  const onCancel = useCallback(() => setOpen(false), [])
  const onConfirm = useCallback(() => {
    setOpen(false)
    download?.start()
  }, [download])

  return {
    guardWontFit,
    confirmation: { open, download, onCancel, onConfirm },
  }
}
