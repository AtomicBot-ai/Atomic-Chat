import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The user (2026-09-14): the scroll bar running up the right side of the window
 * must have "an arrow on top and bottom that is always available to be used".
 *
 * Radium runs in WebView2, which is Chromium. Chromium draws scroll bar arrows
 * only through ::-webkit-scrollbar-button, and since Chromium 121 the standard
 * `scrollbar-width` / `scrollbar-color` properties switch all
 * ::-webkit-scrollbar styling off - so a thin Firefox-style rule applied to
 * every element hides the arrows. These checks keep both halves in place.
 */

const css = readFileSync(new URL('../web-app/src/index.css', import.meta.url), 'utf8')

/** Rule bodies for every selector list that contains `needle`. */
function rulesFor(needle) {
  const bodies = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  for (const match of css.matchAll(pattern)) {
    if (match[1].includes(needle)) bodies.push({ selector: match[1].trim(), body: match[2] })
  }
  return bodies
}

test('the scroll bar draws an up arrow and a down arrow', () => {
  const decrement = rulesFor(':vertical:decrement')
  const increment = rulesFor(':vertical:increment')
  assert.ok(decrement.length > 0, 'no rule for the top (up) arrow')
  assert.ok(increment.length > 0, 'no rule for the bottom (down) arrow')
  for (const { selector, body } of [...decrement, ...increment]) {
    assert.match(body, /background-image\s*:/, `${selector} has no arrow drawn`)
  }
  const buttons = rulesFor('::-webkit-scrollbar-button')
  assert.ok(
    buttons.some(({ body }) => /(height|width)\s*:\s*(1[2-9]|[2-9]\d)px/.test(body) && !/display\s*:\s*none/.test(body)),
    'the arrow buttons have no clickable size'
  )
})

test('the scroll bar is wide enough to use its arrows', () => {
  const bar = rulesFor('::-webkit-scrollbar').filter(({ selector }) => /::-webkit-scrollbar\s*$/.test(selector.split(',').pop()))
  assert.ok(bar.length > 0, 'no ::-webkit-scrollbar rule')
  const width = Math.max(...bar.map(({ body }) => Number(/width\s*:\s*(\d+)px/.exec(body)?.[1] ?? 0)))
  assert.ok(width >= 12, `the scroll bar is ${width}px wide; arrows need at least 12px`)
})

test('the Firefox-only thin scroll bar does not switch the arrows off in Radium', () => {
  // Strip @supports blocks that only Firefox matches, then no rule may set the
  // standard scroll bar properties, which Chromium would obey instead.
  const withoutFirefoxOnly = css.replace(/@supports\s*\(-moz-appearance:\s*none\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  assert.doesNotMatch(withoutFirefoxOnly, /scrollbar-width\s*:/, 'scrollbar-width applies in Chromium and hides the arrows')
  assert.doesNotMatch(withoutFirefoxOnly, /scrollbar-color\s*:/, 'scrollbar-color applies in Chromium and hides the arrows')
})
