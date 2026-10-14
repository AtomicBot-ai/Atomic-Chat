import { createFileRoute } from '@tanstack/react-router'
import { MediaStudio } from '@/containers/media/MediaStudio'

export const Route = createFileRoute('/media')({
  component: MediaWorkspace,
})

function MediaWorkspace() {
  // The library is now a tab inside MediaStudio (Phase 4: user-friendly-first
  // UI). No link prop is injected anymore - the studio owns Create/Library.
  return <MediaStudio />
}
