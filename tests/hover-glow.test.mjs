/**
 * The user (2026-09-14): "Anytime a mouse hovers over an actional button or
 * panel Radium should also have this white line glow. I want mine double the
 * thickness and double the glow. This is for any button i can press or has an
 * action."
 *
 * One rule in web-app/src/index.css does it for the whole app. These checks
 * keep it covering everything pressable, keep its size, and keep it outside
 * @layer so Tailwind utilities (outline-hidden on many buttons) cannot cancel it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(path.join(repoRoot, 'web-app/src/index.css'), 'utf8')

const ruleStart = css.indexOf(':is(', css.indexOf('--action-hover-line'))
const rule = css.slice(ruleStart, css.indexOf('}', ruleStart) + 1)

test('the hover glow rule exists', () => {
  assert.ok(ruleStart > 0, 'the hover glow rule is missing from index.css')
  assert.match(rule, /\):hover:not\(/)
})

test('it covers everything that can be pressed', () => {
  for (const target of [
    'button',
    'a[href]',
    "[role='button']",
    "[role='menuitem']",
    "[role='option']",
    "[role='tab']",
    "[role='switch']",
    "[role='checkbox']",
    "[role='slider']",
    '.cursor-pointer',
  ]) {
    assert.ok(rule.includes(target), `hovering ${target} no longer glows`)
  }
})

test('it leaves disabled controls and full-screen viewers alone', () => {
  for (const skip of [':disabled', "[aria-disabled='true']", '[data-disabled]', '.fixed.inset-0']) {
    assert.ok(rule.includes(skip), `the glow now shows on ${skip}`)
  }
})

test('the line is 1.33px and the glow is double strength', () => {
  // The reference (the Claude connector cards) is a 1px line with an ~8px glow.
  // The user asked for double (2px), then "make the white line 1/3 thinner".
  assert.match(rule, /outline:\s*1\.33px solid var\(--action-hover-line\)/)
  assert.match(rule, /outline-offset:\s*-1\.33px/)
  const blur = Number(/0 0 (\d+)px \d+px var\(--action-hover-glow\)/.exec(rule)?.[1])
  assert.ok(blur >= 16, `the glow blur is ${blur}px, less than double the reference`)
})

test('white in the dark theme, visible in the light theme', () => {
  assert.match(css, /\.dark\s*\{\s*--action-hover-line:\s*oklch\(1 0 0/)
  assert.match(css, /:root\s*\{\s*--action-hover-line:\s*oklch\(0\.145 0 0/)
})

test('it sits outside @layer, so utilities cannot cancel it', () => {
  let depth = 0
  let layerDepth = -1
  for (let i = 0; i < ruleStart; i++) {
    if (css.startsWith('@layer', i) && layerDepth < 0) layerDepth = depth
    if (css[i] === '{') depth++
    if (css[i] === '}') {
      depth--
      if (layerDepth >= 0 && depth === layerDepth) layerDepth = -1
    }
  }
  assert.equal(depth, 0, 'the hover glow rule is nested inside another block')
})
