/**
 * "1.6 GB" / "37 MB", for a download the user is about to start.
 *
 * Kept out of `MediaGenerationForm.tsx` so that file exports only components
 * (`react-refresh/only-export-components`).
 */
export function formatDownloadSize(bytes?: number): string | undefined {
  if (!bytes || bytes <= 0) return undefined
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}
