import { useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'

import { readFileBytes } from '@/lib/readFileBytes'
import {
  MAX_BLOB_CLIP_BYTES,
  webviewReadsAssetMedia,
} from '@/lib/video/webview-playback'

/**
 * What the player plays for a gallery clip: its asset URL, or on Linux a blob:
 * URL of its bytes, because WebKitGTK's media pipeline cannot read `asset:`
 * (`lib/video/webview-playback.ts`). Null while the bytes are read.
 */
export function useAudioClipSrc(path: string): string | null {
  const direct = webviewReadsAssetMedia()
  const [blob, setBlob] = useState<{ path: string; url: string } | null>(null)

  useEffect(() => {
    if (direct) return
    let cancelled = false
    let url: string | null = null
    readFileBytes(path, { maxBytes: MAX_BLOB_CLIP_BYTES })
      .then(({ bytes }) => {
        if (cancelled) return
        url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
        setBlob({ path, url })
      })
      .catch((error) => console.warn('[audios] clip not readable:', error))
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [direct, path])

  if (direct) return convertFileSrc(path)
  return blob?.path === path ? blob.url : null
}
