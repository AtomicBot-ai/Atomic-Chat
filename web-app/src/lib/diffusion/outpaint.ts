/**
 * Extend (outpaint) geometry. Pure: the pixel work happens in
 * `containers/images/canvas.ts`, this only decides the numbers, so the
 * seam, the clamp and the snapping are unit-tested without a canvas.
 *
 * Mirrors Studio's `buildOutpaint`: the canvas grows by a percentage of the
 * source on each chosen side, the original sits inside it, and the mask is
 * white everywhere except a black rectangle over the kept original, inset
 * by a small overlap so the repaint blends into the picture instead of
 * meeting it at a hard edge.
 */

import { snapDim, type DimConstraints } from './size'

export type OutpaintSides = {
  top: boolean
  bottom: boolean
  left: boolean
  right: boolean
}

export type OutpaintGeometry = {
  /** The grown canvas, snapped to what the model accepts. */
  width: number
  height: number
  /** Where the original is drawn on the grown canvas. */
  offsetX: number
  offsetY: number
  /** Size the original is drawn at (its own size unless the canvas was clamped). */
  drawWidth: number
  drawHeight: number
  /** The black (keep) rectangle of the mask. */
  keep: { x: number; y: number; width: number; height: number }
}

/** How far the mask's keep rectangle backs off from the original's edge. */
export const SEAM_OVERLAP = 0.02

export const ALL_SIDES: OutpaintSides = {
  top: true,
  bottom: true,
  left: true,
  right: true,
}

export function anySide(sides: OutpaintSides): boolean {
  return sides.top || sides.bottom || sides.left || sides.right
}

export function outpaintGeometry(input: {
  width: number
  height: number
  /** 10..100: how much of the source size each chosen side adds. */
  expandPercent: number
  sides: OutpaintSides
  constraints: DimConstraints
}): OutpaintGeometry {
  const { width, height, sides, constraints } = input
  const pct = Math.max(0, input.expandPercent) / 100
  const padX = Math.round(width * pct)
  const padY = Math.round(height * pct)
  const left = sides.left ? padX : 0
  const right = sides.right ? padX : 0
  const top = sides.top ? padY : 0
  const bottom = sides.bottom ? padY : 0

  const rawWidth = width + left + right
  const rawHeight = height + top + bottom
  // The model has a ceiling; when the grown canvas is over it, the whole
  // picture is scaled down so every side keeps its share of new space.
  const scale = Math.min(
    1,
    constraints.maxDim / rawWidth,
    constraints.maxDim / rawHeight
  )
  const canvasWidth = snapDim(rawWidth * scale, constraints)
  const canvasHeight = snapDim(rawHeight * scale, constraints)
  const sx = canvasWidth / rawWidth
  const sy = canvasHeight / rawHeight

  const offsetX = Math.round(left * sx)
  const offsetY = Math.round(top * sy)
  const drawWidth = Math.max(1, Math.round(width * sx))
  const drawHeight = Math.max(1, Math.round(height * sy))

  const insetX = Math.round(drawWidth * SEAM_OVERLAP)
  const insetY = Math.round(drawHeight * SEAM_OVERLAP)
  const keep = {
    x: offsetX + (sides.left ? insetX : 0),
    y: offsetY + (sides.top ? insetY : 0),
    width: drawWidth - (sides.left ? insetX : 0) - (sides.right ? insetX : 0),
    height: drawHeight - (sides.top ? insetY : 0) - (sides.bottom ? insetY : 0),
  }

  return {
    width: canvasWidth,
    height: canvasHeight,
    offsetX,
    offsetY,
    drawWidth,
    drawHeight,
    keep,
  }
}
