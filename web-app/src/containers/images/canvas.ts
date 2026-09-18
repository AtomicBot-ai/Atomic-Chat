/**
 * The pixel work the Extend workflow needs, kept apart from the pure
 * geometry in `lib/diffusion/outpaint.ts` so the numbers are tested without
 * a canvas and this stays a thin DOM shim.
 */

import type { OutpaintGeometry } from '@/lib/diffusion/outpaint'

export type OutpaintCanvases = {
  /** The grown picture, PNG data URL. */
  initBase64: string
  /** White where the model paints, black over the kept original. */
  maskBase64: string
}

/** Load an image from a same-origin URL (a blob URL) so drawing it never taints a canvas. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The source image could not be decoded.'))
    image.src = url
  })
}

const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is not available.')
  return { canvas, context }
}

/**
 * Grow the picture onto a bigger canvas and build the matching mask.
 *
 * The new bands are filled by stretching the source's one-pixel edge rows
 * and columns outwards (and the corner pixels into the corners) rather than
 * left blank: the model then continues colours it can see instead of
 * inventing them from black, and the seam is far less visible.
 */
export function drawOutpaint(
  image: HTMLImageElement,
  geometry: OutpaintGeometry
): OutpaintCanvases {
  const { width, height, offsetX, offsetY, drawWidth, drawHeight, keep } =
    geometry
  const { canvas, context } = makeCanvas(width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight)

  const sw = image.naturalWidth
  const sh = image.naturalHeight
  const right = offsetX + drawWidth
  const bottom = offsetY + drawHeight
  // Edge bleed: each band takes the outermost row/column of the source.
  if (offsetY > 0) {
    context.drawImage(image, 0, 0, sw, 1, offsetX, 0, drawWidth, offsetY)
  }
  if (bottom < height) {
    context.drawImage(image, 0, sh - 1, sw, 1, offsetX, bottom, drawWidth, height - bottom)
  }
  if (offsetX > 0) {
    context.drawImage(image, 0, 0, 1, sh, 0, offsetY, offsetX, drawHeight)
  }
  if (right < width) {
    context.drawImage(image, sw - 1, 0, 1, sh, right, offsetY, width - right, drawHeight)
  }
  // Corners take the corner pixel.
  if (offsetX > 0 && offsetY > 0) {
    context.drawImage(image, 0, 0, 1, 1, 0, 0, offsetX, offsetY)
  }
  if (right < width && offsetY > 0) {
    context.drawImage(image, sw - 1, 0, 1, 1, right, 0, width - right, offsetY)
  }
  if (offsetX > 0 && bottom < height) {
    context.drawImage(image, 0, sh - 1, 1, 1, 0, bottom, offsetX, height - bottom)
  }
  if (right < width && bottom < height) {
    context.drawImage(image, sw - 1, sh - 1, 1, 1, right, bottom, width - right, height - bottom)
  }

  const mask = makeCanvas(width, height)
  mask.context.fillStyle = '#ffffff'
  mask.context.fillRect(0, 0, width, height)
  mask.context.fillStyle = '#000000'
  mask.context.fillRect(keep.x, keep.y, keep.width, keep.height)

  return {
    initBase64: canvas.toDataURL('image/png'),
    maskBase64: mask.canvas.toDataURL('image/png'),
  }
}
