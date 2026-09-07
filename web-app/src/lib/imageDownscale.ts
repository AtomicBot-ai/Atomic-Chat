/**
 * Result of normalizing an image. `mimeType` may differ from the input: WebP is
 * always transcoded (not every vision backend — notably local llama.cpp — can
 * decode WebP), and a downscaled image is re-encoded as JPEG unless it carries
 * transparency, which only PNG can keep. See {@link encodeCanvas}.
 */
export type DownscaledImage = {
  dataUrl: string
  base64: string
  mimeType: string
  size: number
}

const base64Bytes = (base64: string): number => {
  // 4 base64 chars encode 3 bytes; subtract padding.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = dataUrl
  })

const isWebp = (mimeType?: string): boolean => mimeType === 'image/webp'
const isJpeg = (mimeType?: string): boolean =>
  mimeType === 'image/jpeg' || mimeType === 'image/jpg'

/**
 * Hard ceiling (longest edge, px) applied when transcoding WebP even if
 * downscaling is disabled ("Original"). A re-encoded photo is far heavier than
 * its WebP source, so an 8K WebP would otherwise balloon into a huge file.
 */
const WEBP_TRANSCODE_MAX_PX = 4096

const JPEG_QUALITY = 0.92

/**
 * An opaque image whose lossless PNG comes in at or under this many bytes is
 * kept as PNG: flat-colour screenshots and UI captures are usually small and
 * look crisper lossless. Above it the JPEG encode is worth paying for.
 */
const PNG_KEEP_BYTES = 4 * 1024 * 1024

/** Bytes of RGBA read per `getImageData` call while scanning for alpha. */
const ALPHA_SCAN_BAND_BYTES = 4 * 1024 * 1024

/**
 * True when any pixel on the canvas is not fully opaque. Reads the bitmap in
 * row bands so `getImageData` never has to allocate the whole image, and stops
 * at the first translucent pixel. The scan is exhaustive on purpose: sampling
 * would miss a transparent border or rounded corners and flatten them onto
 * black in the JPEG.
 */
const canvasHasAlpha = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): boolean => {
  const rowsPerBand = Math.max(
    1,
    Math.floor(ALPHA_SCAN_BAND_BYTES / (width * 4))
  )
  for (let y = 0; y < height; y += rowsPerBand) {
    const rows = Math.min(rowsPerBand, height - y)
    const { data } = ctx.getImageData(0, y, width, rows)
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255) return true
    }
  }
  return false
}

type EncodedCanvas = { dataUrl: string; mimeType: 'image/jpeg' | 'image/png' }

/**
 * Pick the output encoding for a drawn canvas:
 *  1. JPEG input stays JPEG.
 *  2. Anything with transparency becomes PNG — the only lossless-alpha option
 *     every backend decodes.
 *  3. An opaque PNG/WebP is encoded as PNG first; if that lands over
 *     {@link PNG_KEEP_BYTES} it is also encoded as JPEG and the smaller wins.
 *
 * Rule 3 is what keeps a detailed 5120² PNG under the attachment size limit
 * after downscaling (#262): lossless PNG of a photo at 2048 px is routinely
 * 10–20 MB, and the vision tower resamples it anyway, so lossless buys no
 * accuracy — only payload.
 */
const encodeCanvas = (
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  inputMimeType?: string
): EncodedCanvas => {
  if (isJpeg(inputMimeType)) {
    return {
      dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
      mimeType: 'image/jpeg',
    }
  }

  const png = canvas.toDataURL('image/png')
  if (canvasHasAlpha(ctx, canvas.width, canvas.height)) {
    return { dataUrl: png, mimeType: 'image/png' }
  }

  const pngBytes = base64Bytes(png.split(',')[1] ?? '')
  if (pngBytes <= PNG_KEEP_BYTES) {
    return { dataUrl: png, mimeType: 'image/png' }
  }

  const jpeg = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  const jpegBytes = base64Bytes(jpeg.split(',')[1] ?? '')
  return jpegBytes < pngBytes
    ? { dataUrl: jpeg, mimeType: 'image/jpeg' }
    : { dataUrl: png, mimeType: 'image/png' }
}

/**
 * Normalize an image data URL for sending to a model:
 *  - Downscale so its longest edge does not exceed `maxDimensionPx` (preserving
 *    aspect ratio). `0`/invalid disables downscaling.
 *  - Transcode WebP (to PNG or JPEG, see {@link encodeCanvas}) for broad
 *    backend compatibility, clamping the result to
 *    {@link WEBP_TRANSCODE_MAX_PX} even when downscaling is disabled.
 *
 * Returns `null` when no work is needed (image already within bounds and not
 * WebP) or on any failure, so the caller keeps the original image untouched.
 *
 * Large images otherwise inflate the model's context (and base64 payload),
 * which is exactly what the "max image size" setting guards against.
 */
export async function downscaleImageDataUrl(
  dataUrl: string,
  maxDimensionPx: number,
  mimeType?: string
): Promise<DownscaledImage | null> {
  if (!dataUrl || typeof document === 'undefined') {
    return null
  }

  const limit =
    Number.isFinite(maxDimensionPx) && maxDimensionPx > 0
      ? maxDimensionPx
      : Infinity
  const mustTranscode = isWebp(mimeType)
  // WebP transcoding always re-encodes; keep the result within a sane ceiling
  // even when the user disabled downscaling.
  const effectiveLimit = mustTranscode
    ? Math.min(limit, WEBP_TRANSCODE_MAX_PX)
    : limit

  try {
    const img = await loadImage(dataUrl)
    const { naturalWidth: width, naturalHeight: height } = img
    if (width === 0 || height === 0) return null

    const longestEdge = Math.max(width, height)
    const needsResize = longestEdge > effectiveLimit

    // Nothing to do — leave the original untouched.
    if (!needsResize && !mustTranscode) {
      return null
    }

    const scale = needsResize ? effectiveLimit / longestEdge : 1
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

    const { dataUrl: outDataUrl, mimeType: outMime } = encodeCanvas(
      canvas,
      ctx,
      mimeType
    )

    const base64 = outDataUrl.split(',')[1] ?? ''
    if (!base64) return null

    return {
      dataUrl: outDataUrl,
      base64,
      mimeType: outMime,
      size: base64Bytes(base64),
    }
  } catch (error) {
    console.debug('Image normalize failed; keeping original:', error)
    return null
  }
}
