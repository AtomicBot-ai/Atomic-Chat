import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTags } from '../scripts/gen-amd-rocm-pci-ids.mjs'

test('ROCm table text strips nested tags that reassemble after one pass', () => {
  const cleaned = stripTags('<scr<b>ipt>RX 7900 XTX</scr</b>ipt>')
  assert.doesNotMatch(cleaned, /[<>]/)
  assert.ok(cleaned.includes('RX 7900 XTX'))
  assert.equal(stripTags('<b>Radeon</b> <em>RX 7900 XTX</em>'), 'Radeon RX 7900 XTX')
})

test('incomplete tags cannot survive as angle brackets in GPU names', () => {
  assert.equal(stripTags('RX <7900 XTX>'), 'RX ')
  assert.equal(stripTags('RX 7900 XTX <'), 'RX 7900 XTX ')
  assert.equal(stripTags('RX 7900 XTX >'), 'RX 7900 XTX ')
})
