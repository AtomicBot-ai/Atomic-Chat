import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ImageMaskCanvas } from '../ImageMaskCanvas'

describe('ImageMaskCanvas', () => {
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineCap: '',
    lineJoin: '',
    lineWidth: 0,
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  }
  const toDataURL = vi.fn(() => 'data:image/png;base64,TUFTSw==')
  const setPointerCapture = vi.fn()

  beforeEach(() => {
    // The context is shared; each test reads only its own strokes.
    vi.clearAllMocks()
  })

  beforeAll(() => {
    // jsdom may lack PointerEvent; without it the pointer coordinates never
    // reach the handler.
    if (!('PointerEvent' in window)) {
      class PointerEventPolyfill extends MouseEvent {
        pointerId: number
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init)
          this.pointerId = init.pointerId ?? 0
        }
      }
      Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill })
    }
    // jsdom has no 2D context; the stroke calls are what matters here.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => context) as never
    HTMLCanvasElement.prototype.toDataURL = toDataURL
    HTMLCanvasElement.prototype.setPointerCapture = setPointerCapture
    HTMLCanvasElement.prototype.hasPointerCapture = vi.fn(() => false)
    HTMLCanvasElement.prototype.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect
  })

  it('emits the mask PNG after a stroke and nothing on an empty release', () => {
    const onMaskChange = vi.fn()
    render(
      <ImageMaskCanvas
        src="blob:source"
        width={1000}
        height={500}
        brushPercent={8}
        resetKey={0}
        onMaskChange={onMaskChange}
      />
    )
    const canvas = screen.getByTestId('image-mask-canvas')

    fireEvent.pointerUp(canvas, { pointerId: 1 })
    expect(onMaskChange).not.toHaveBeenCalled()

    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 20, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })

    expect(onMaskChange).toHaveBeenCalledWith('data:image/png;base64,TUFTSw==')
    // Display coordinates map onto the picture's own pixels.
    expect(context.moveTo).toHaveBeenCalledWith(100, 50)
    expect(context.lineTo).toHaveBeenCalledWith(200, 50)
    // Brush: 8 % of the shorter side (500) → radius 40 → line width 80.
    expect(context.lineWidth).toBe(80)
  })

  it('does not paint while disabled', () => {
    const onMaskChange = vi.fn()
    const props = {
      src: 'blob:source',
      width: 1000,
      height: 500,
      brushPercent: 8,
      resetKey: 0,
      onMaskChange,
    }
    const { rerender } = render(<ImageMaskCanvas {...props} disabled />)
    const canvas = screen.getByTestId('image-mask-canvas')
    // The box shows it is locked instead of offering the brush.
    expect(canvas).toHaveClass('cursor-not-allowed')
    expect(canvas).not.toHaveClass('cursor-crosshair')

    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 20, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    expect(onMaskChange).not.toHaveBeenCalled()
    // Nothing reached either canvas and the pointer was never captured.
    expect(context.arc.mock.calls).toEqual([])
    expect(context.moveTo.mock.calls).toEqual([])
    expect(context.lineTo.mock.calls).toEqual([])
    expect(setPointerCapture.mock.calls).toEqual([])

    // Once enabled, the same press paints a dot on both canvases and emits the
    // mask, so the silence above came from `disabled`, not from the setup.
    rerender(<ImageMaskCanvas {...props} />)
    expect(canvas).toHaveClass('cursor-crosshair')
    fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 20, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    const dot = [100, 50, 40, 0, Math.PI * 2]
    expect(context.arc.mock.calls).toEqual([dot, dot])
    expect(onMaskChange.mock.calls).toEqual([['data:image/png;base64,TUFTSw==']])
  })
})
