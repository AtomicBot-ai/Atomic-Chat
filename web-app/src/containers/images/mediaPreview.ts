import type { CSSProperties } from 'react'

/**
 * The tallest the open picture or clip may be drawn: three fifths of the
 * media pane less what the viewer puts around the preview — its top and
 * bottom padding, the gap and the toolbar row (1rem + 0.5rem + 0.5rem + the
 * control height). With its actions the preview then never takes more than
 * the old fixed 3:2 split gave the viewer, so a portrait picture leaves the
 * gallery two fifths of the pane, and a wide one leaves it everything it does
 * not use.
 *
 * `cqh` is the media pane's: the size container the Images and Video pages
 * wrap around the viewer and the gallery. A viewer rendered on its own has
 * none, and `cqh` is then the viewport's height.
 */
const PREVIEW_MAX_HEIGHT = '(60cqh - 2rem - var(--control-height, 2.25rem))'

/**
 * The preview frame's size: the media's aspect at the largest box that fits
 * the viewer's width (`cqw` of the nearest inline-size container) and
 * `PREVIEW_MAX_HEIGHT`. The frame is content-sized, so the toolbar placed
 * after it sits on its bottom edge rather than at the bottom of the pane.
 */
export function mediaPreviewFrameStyle(
  width: number,
  height: number
): CSSProperties {
  const w = Math.max(width, 1)
  const h = Math.max(height, 1)
  return {
    width: `min(100cqw, ${PREVIEW_MAX_HEIGHT} * ${w / h})`,
    height: `min(${(100 * h) / w}cqw, ${PREVIEW_MAX_HEIGHT})`,
  }
}
