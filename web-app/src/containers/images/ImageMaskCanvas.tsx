import { memo, useCallback, useEffect, useRef, type PointerEvent } from 'react'

import { cn } from '@/lib/utils'

type ImageMaskCanvasProps = {
  /** Same-origin URL of the source picture. */
  src: string
  /** Natural size of the picture: the hidden mask is drawn at this size. */
  width: number
  height: number
  /** Brush radius as a percent of the shorter side. */
  brushPercent: number
  /** Bump to wipe the mask. */
  resetKey: number
  disabled?: boolean
  /** The mask as a PNG data URL after each stroke, or `null` when nothing is painted. */
  onMaskChange: (maskBase64: string | null) => void
  className?: string
}

const OVERLAY_COLOR = 'rgba(244, 114, 114, 0.55)'

/**
 * Paint the area to regenerate. Two canvases: the visible one strokes a
 * translucent red over the picture at display size; a hidden one at the
 * picture's native size keeps the real mask, black with white strokes —
 * white is what sd.cpp repaints. Pointer capture keeps a stroke going when
 * the pointer leaves the box; the mask is emitted on pointer-up.
 */
export const ImageMaskCanvas = memo(function ImageMaskCanvas({
  src,
  width,
  height,
  brushPercent,
  resetKey,
  disabled,
  onMaskChange,
  className,
}: ImageMaskCanvasProps) {
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const painted = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)

  const radius = Math.max(2, (brushPercent / 100) * Math.min(width, height))

  // A fresh mask whenever the picture or the reset key changes.
  useEffect(() => {
    const mask = document.createElement('canvas')
    mask.width = width
    mask.height = height
    const context = mask.getContext('2d')
    if (context) {
      context.fillStyle = '#000000'
      context.fillRect(0, 0, width, height)
    }
    maskRef.current = mask
    painted.current = false
    const overlay = overlayRef.current
    overlay?.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
  }, [src, width, height, resetKey])

  /** Pointer position in natural pixels. */
  const toNatural = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const overlay = overlayRef.current
      if (!overlay) return null
      const rect = overlay.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      return {
        x: ((event.clientX - rect.left) / rect.width) * width,
        y: ((event.clientY - rect.top) / rect.height) * height,
      }
    },
    [width, height]
  )

  const stroke = useCallback(
    (from: { x: number; y: number } | null, to: { x: number; y: number }) => {
      const mask = maskRef.current
      const overlay = overlayRef.current
      if (!mask || !overlay) return
      for (const [canvas, color] of [
        [mask, '#ffffff'],
        [overlay, OVERLAY_COLOR],
      ] as const) {
        const context = canvas.getContext('2d')
        if (!context) continue
        context.strokeStyle = color
        context.fillStyle = color
        context.lineCap = 'round'
        context.lineJoin = 'round'
        context.lineWidth = radius * 2
        context.beginPath()
        if (from) {
          context.moveTo(from.x, from.y)
          context.lineTo(to.x, to.y)
          context.stroke()
        } else {
          context.arc(to.x, to.y, radius, 0, Math.PI * 2)
          context.fill()
        }
      }
      painted.current = true
    },
    [radius]
  )

  const onDown = (event: PointerEvent<HTMLCanvasElement>) => {
    // Only the primary button paints; a secondary press is left to the page.
    if (disabled || event.button > 0) return
    const point = toNatural(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drawing.current = true
    last.current = point
    stroke(null, point)
  }

  const onMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const point = toNatural(event)
    if (!point) return
    stroke(last.current, point)
    last.current = point
  }

  const onUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const mask = maskRef.current
    onMaskChange(mask && painted.current ? mask.toDataURL('image/png') : null)
  }

  return (
    <div
      className={cn('relative overflow-hidden rounded-2xl border border-border bg-secondary/40', className)}
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      <img src={src} alt="" draggable={false} className="block size-full object-contain" />
      <canvas
        ref={overlayRef}
        width={width}
        height={height}
        className={cn(
          'absolute inset-0 size-full touch-none',
          disabled ? 'cursor-not-allowed' : 'cursor-crosshair'
        )}
        data-testid="image-mask-canvas"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </div>
  )
})

export default ImageMaskCanvas
