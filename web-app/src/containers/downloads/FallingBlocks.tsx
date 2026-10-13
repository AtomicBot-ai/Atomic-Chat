import { useEffect, useRef } from 'react'

import { COLS, ROWS, fieldFor } from '@/lib/downloadBlockFields'
import {
  BLOCK_COLOURS,
  CLEAR_FLASH_SECONDS,
  CLEAR_VANISH_SECONDS,
  stepBlockField,
  type BlockField,
} from '@/lib/downloadBlocks'


/** Four shades of the download's hue, so the stack reads as one colour. */
function shade(hue: number, colour: number, light = 0): string {
  const l = 46 + colour * 7 + light
  return `hsl(${hue} 70% ${Math.min(l, 92)}%)`
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  hue: number,
  colour: number,
  options: { flash?: number; scale?: number } = {}
) {
  const scale = options.scale ?? 1
  if (scale <= 0) return
  const inset = (size * (1 - scale)) / 2 + 1
  const s = size - inset * 2
  if (s <= 0) return
  const light = (options.flash ?? 0) * 40
  ctx.fillStyle = shade(hue, colour, light)
  ctx.fillRect(x + inset, y + inset, s, s)
  // A light top edge and a dark bottom edge give each block a little depth.
  ctx.fillStyle = 'rgba(255,255,255,0.28)'
  ctx.fillRect(x + inset, y + inset, s, Math.max(1, s * 0.16))
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.fillRect(x + inset, y + inset + s * 0.84, s, Math.max(1, s * 0.16))
}

function draw(
  ctx: CanvasRenderingContext2D,
  field: BlockField,
  width: number,
  height: number,
  hue: number,
  paused: boolean
) {
  const size = Math.min(width / field.cols, height / field.rows)
  const left = (width - size * field.cols) / 2
  const top = height - size * field.rows

  ctx.clearRect(0, 0, width, height)

  // The well: a faint grid so the empty space reads as a playfield.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'
  ctx.lineWidth = 1
  for (let c = 0; c <= field.cols; c += 1) {
    ctx.beginPath()
    ctx.moveTo(left + c * size + 0.5, top)
    ctx.lineTo(left + c * size + 0.5, top + size * field.rows)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'
  ctx.strokeRect(left + 0.5, top + 0.5, size * field.cols, size * field.rows - 1)

  ctx.globalAlpha = paused ? 0.45 : 1
  const clearing = field.clear
  const flashing = clearing && clearing.t < CLEAR_FLASH_SECONDS
  const vanish = clearing
    ? Math.max(0, (clearing.t - CLEAR_FLASH_SECONDS) / CLEAR_VANISH_SECONDS)
    : 0

  for (let col = 0; col < field.cols; col += 1) {
    const stack = field.stacks[col]!
    for (let i = 0; i < stack.length; i += 1) {
      // After a clear, the rows above slide down into the gap instead of jumping.
      const row = field.rows - 1 - i - field.settle * field.clearRows
      const inClearedRows = clearing ? i < clearing.rows : false
      let flash = 0
      let scale = 1
      if (inClearedRows && clearing) {
        // Quick strobing white, then each cell shrinks away.
        flash = flashing ? (Math.floor(clearing.t * 20) % 2 === 0 ? 1 : 0.2) : 1
        scale = flashing ? 1 : 1 - vanish
      }
      drawCell(ctx, left + col * size, top + row * size, size, hue, stack[i]!, {
        flash,
        scale,
      })
    }
  }

  for (const block of field.falling) {
    if (block.y + 1 <= 0) continue
    drawCell(ctx, left + block.col * size, top + block.y * size, size, hue, block.colour)
  }
  ctx.globalAlpha = 1
}

/** Static stack for people who ask for reduced motion: height follows progress. */
function drawStatic(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hue: number,
  progress: number
) {
  const size = Math.min(width / COLS, height / ROWS)
  const left = (width - size * COLS) / 2
  const top = height - size * ROWS
  ctx.clearRect(0, 0, width, height)
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'
  ctx.strokeRect(left + 0.5, top + 0.5, size * COLS, size * ROWS - 1)
  const rows = Math.round(progress * ROWS * 0.6)
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      drawCell(ctx, left + c * size, top + (ROWS - 1 - r) * size, size, hue, (r + c) % BLOCK_COLOURS)
    }
  }
}

/**
 * The falling-blocks picture for one download. It is decoration: blocks fall at
 * one fixed rate whatever the file, and the real figures are written beside it.
 * Each download keeps its own field, so switching tabs does not restart it.
 */
export function FallingBlocks({
  id,
  hue,
  paused,
  progress,
  className,
}: {
  id: string
  hue: number
  paused?: boolean
  progress: number
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const live = useRef({ hue, paused: Boolean(paused), progress })
  live.current = { hue, paused: Boolean(paused), progress }

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    let last = performance.now()
    let width = 0
    let height = 0

    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(() => {
      resize()
      if (reduced) drawStatic(ctx, width, height, live.current.hue, live.current.progress)
    })
    observer.observe(canvas)

    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const field = fieldFor(id)
      stepBlockField(field, dt, live.current.paused)
      draw(ctx, field, width, height, live.current.hue, live.current.paused)
      frame = requestAnimationFrame(tick)
    }
    if (reduced) {
      drawStatic(ctx, width, height, live.current.hue, live.current.progress)
    } else {
      frame = requestAnimationFrame(tick)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [id])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="falling-blocks"
      className={className}
    />
  )
}
