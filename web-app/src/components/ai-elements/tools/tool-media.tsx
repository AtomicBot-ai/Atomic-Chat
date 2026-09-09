import { memo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { ToolMedia } from '@/lib/tool-media'
import { classifyWorkspacePreview } from '@/lib/workspace-preview-kind'
import { agentPathBasename } from '@/lib/agent-path'
import { useServiceHub } from '@/hooks/useServiceHub'

type InlineVideoProps = {
  url: string
  poster?: string
  className?: string
}

/**
 * A remote video inline in the chat, with native controls. A decode or
 * network failure degrades to the URL as a link rather than a dead player.
 */
export const InlineVideo = memo(({ url, poster, className }: InlineVideoProps) => {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-xs underline break-all text-muted-foreground"
      >
        {url}
      </a>
    )
  }
  // The wrapper owns the rounding and the border: WebKit clips the picture
  // to a rounded <video>, but still paints the element's own border box
  // square, which shows as grey corners.
  return (
    <div
      className={cn(
        'inline-block max-w-full overflow-hidden rounded-xl border bg-black align-top',
        className
      )}
    >
      <video
        key={url}
        src={url}
        poster={poster}
        controls
        playsInline
        preload="metadata"
        className="block max-w-full max-h-96 w-auto h-auto"
        onError={() => setFailed(true)}
      />
    </div>
  )
})
InlineVideo.displayName = 'InlineVideo'

type AgentLocalMediaProps = {
  /** Absolute path on this machine, as the agent wrote or produced it. */
  path: string
  label?: ReactNode
}

/**
 * A local file the agent referenced as a Markdown image: played or shown
 * through the asset protocol when the webview can decode it, otherwise a
 * link that opens the file with the OS.
 */
export function AgentLocalMedia({ path, label }: AgentLocalMediaProps) {
  const serviceHub = useServiceHub()
  const kind = classifyWorkspacePreview(path)
  const name = agentPathBasename(path)

  if (kind === 'video') {
    return (
      <InlineVideo url={serviceHub.core().convertFileSrc(path)} className="my-2" />
    )
  }
  if (kind === 'image') {
    return (
      <img
        src={serviceHub.core().convertFileSrc(path)}
        alt={typeof label === 'string' ? label : name}
        className="max-w-full max-h-96 w-auto h-auto object-contain rounded-md border my-2"
      />
    )
  }
  return (
    <a
      href={path}
      onClick={(event) => {
        event.preventDefault()
        void serviceHub
          .opener()
          .openPath(path)
          .catch((error) => {
            console.error('Failed to open Agent file:', error)
          })
      }}
    >
      {label ?? name}
    </a>
  )
}

type ToolMediaGalleryProps = {
  media: ToolMedia[]
  className?: string
}

/** Images and videos a tool result points at, rendered above its raw output. */
export const ToolMediaGallery = memo(
  ({ media, className }: ToolMediaGalleryProps) => {
    if (media.length === 0) return null
    return (
      <div
        className={cn('flex flex-wrap gap-2', className)}
        data-testid="tool-media-gallery"
      >
        {media.map((item) =>
          item.kind === 'video' ? (
            <InlineVideo key={item.url} url={item.url} poster={item.poster} />
          ) : (
            <img
              key={item.url}
              src={item.url}
              alt="Tool output"
              loading="lazy"
              className="max-w-full max-h-96 w-auto h-auto object-contain rounded-md border"
            />
          )
        )}
      </div>
    )
  }
)
ToolMediaGallery.displayName = 'ToolMediaGallery'
