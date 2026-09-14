import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The user's Radium logo (2026-09-14) replaces the Atomic mark everywhere: the
 * app and installer icon (generated from src-tauri/icons/icon.png), the web
 * logo images, the sidebar, the first-run and setup screens, the loading
 * screen, chat avatars and messages. The new logo is a full-colour tile, so no
 * screen may invert or tint it the way the old black-and-white mark was.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url))

function pngSize(path) {
  const data = read(path)
  assert.equal(data.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`)
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    colourType: data[25],
  }
}

test('the app icon source is the square Radium logo with transparent corners', () => {
  const icon = pngSize('src-tauri/icons/icon.png')
  assert.equal(icon.width, 1024)
  assert.equal(icon.height, 1024)
  // Colour type 6 = RGBA, so the corners outside the rounded tile can be clear.
  assert.equal(icon.colourType, 6)
})

test('every web logo image is the Radium logo', () => {
  const icon = read('web-app/public/images/transparent-logo.png')
  for (const name of ['atomic-chat-logo.png', 'logo.png', 'logo-app.png']) {
    assert.deepEqual(
      read(`web-app/public/images/${name}`),
      icon,
      `${name} still holds an old logo`
    )
  }
  const size = pngSize('web-app/public/images/transparent-logo.png')
  assert.equal(size.width, 512)
  assert.equal(size.colourType, 6)
})

test('no screen inverts or tints the logo', () => {
  const screens = [
    'web-app/src/components/AppLogo.tsx',
    'web-app/src/containers/SetupBackendStep.tsx',
    'web-app/src/components/MermaidError.tsx',
    'web-app/src/containers/PromptVisionModel.tsx',
    'web-app/src/containers/AvatarEmoji.tsx',
  ]
  for (const path of screens) {
    const source = read(path).toString('utf8')
    for (const match of source.matchAll(/<img[\s\S]*?\/>/g)) {
      if (!/logo/.test(match[0]) && !/isCustomImageAvatar|avatar/.test(match[0])) continue
      assert.doesNotMatch(match[0], /invert|brightness-0/, `${path} tints the logo`)
    }
    assert.doesNotMatch(
      source,
      /isAtomicChatLogoPath|dark:brightness-0 dark:invert/,
      `${path} still tints the logo`
    )
  }
  assert.doesNotMatch(
    read('web-app/src/loader.css').toString('utf8'),
    /loader-logo-spin img \{\s*filter: invert/,
    'the loading screen inverts the logo'
  )
})
