import { useEffect, useState } from 'react'

import { FileTooLargeError, readFileBytes } from '@/lib/readFileBytes'
import { MAX_SOURCE_IMAGE_BYTES } from '@/lib/diffusion/workflows'

type SourceImageUrl = {
  /** A blob URL for the file, same-origin so a canvas drawn from it is never tainted. */
  url: string | null
  /** Natural size once the picture decoded. */
  size: { width: number; height: number } | null
  error: string | null
}

/**
 * Read a picked image into a blob URL. The bytes come through the paged
 * `read_file_chunk` command rather than `convertFileSrc`: the asset protocol
 * is another origin, and the mask and outpaint canvases must draw the
 * picture without being tainted.
 */
export function useSourceImageUrl(path: string | null): SourceImageUrl {
  const [state, setState] = useState<SourceImageUrl>({
    url: null,
    size: null,
    error: null,
  })

  useEffect(() => {
    if (!path) {
      setState({ url: null, size: null, error: null })
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setState({ url: null, size: null, error: null })
    readFileBytes(path, { maxBytes: MAX_SOURCE_IMAGE_BYTES })
      .then(({ bytes }) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(new Blob([bytes]))
        const image = new Image()
        image.onload = () => {
          if (cancelled) return
          setState({
            url: objectUrl,
            size: { width: image.naturalWidth, height: image.naturalHeight },
            error: null,
          })
        }
        image.onerror = () => {
          if (cancelled) return
          setState({ url: null, size: null, error: 'The file is not an image.' })
        }
        image.src = objectUrl
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message =
          error instanceof FileTooLargeError
            ? `The file is ${Math.round(error.size / 1024 / 1024)} MB; the limit is ${Math.round(error.maxBytes / 1024 / 1024)} MB.`
            : error instanceof Error
              ? error.message
              : String(error)
        setState({ url: null, size: null, error: message })
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  return state
}
