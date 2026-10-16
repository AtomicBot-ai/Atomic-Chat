/**
 * One extension must not be able to keep the app from drawing.
 *
 * `load()` and `registerActive()` used to be bare `Promise.all`s: one
 * extension whose `onLoad` threw left `ExtensionProvider` waiting for good
 * (a blank window), one that never resolved held it there too, and one that
 * failed to import stopped every other extension from registering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getActiveExtensions = vi.fn()

vi.mock('@janhq/core', () => ({
  AIEngine: class MockAIEngine {},
  BaseExtension: class MockBaseExtension {},
  ExtensionTypeEnum: {},
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    core: () => ({
      getActiveExtensions,
      convertFileSrc: (path: string) => path,
    }),
  }),
}))

import {
  EXTENSION_LOAD_TIMEOUT_MS,
  Extension,
  ExtensionManager,
} from '../extension'
import type { BaseExtension } from '@janhq/core'

const fake = (onLoad: () => unknown) =>
  ({ onLoad, onUnload: () => {} }) as unknown as BaseExtension

describe('extension load isolation', () => {
  let manager: ExtensionManager
  const steps: string[] = []
  const logs: string[] = []

  beforeEach(() => {
    manager = new ExtensionManager()
    steps.length = 0
    logs.length = 0
    window.__radiumBoot = {
      step: (_id, label) => steps.push(label ?? ''),
      ready: () => {},
      fail: () => {},
      log: (_level, message) => logs.push(message),
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    delete window.__radiumBoot
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('carries on when an onLoad throws, and records it', async () => {
    const good = vi.fn()
    manager.register('@janhq/good-extension', fake(good))
    manager.register(
      '@janhq/broken-extension',
      fake(() => {
        throw new Error('boom')
      })
    )

    await expect(manager.load()).resolves.toBeUndefined()

    expect(good).toHaveBeenCalledOnce()
    expect(manager.getLoadFailures()).toEqual([
      { name: '@janhq/broken-extension', reason: 'error', message: 'boom' },
    ])
    expect(logs.some((line) => line.includes('broken-extension failed to load'))).toBe(true)
  })

  it('carries on when an onLoad rejects', async () => {
    manager.register(
      '@janhq/rejecting-extension',
      fake(() => Promise.reject(new Error('nope')))
    )
    await manager.load()
    expect(manager.getLoadFailures()[0]).toMatchObject({
      name: '@janhq/rejecting-extension',
      reason: 'error',
      message: 'nope',
    })
  })

  it('stops waiting for an onLoad that never finishes', async () => {
    vi.useFakeTimers()
    manager.register('@janhq/fast-extension', fake(() => Promise.resolve()))
    manager.register('@janhq/stuck-extension', fake(() => new Promise(() => {})))

    const loading = manager.load()
    let settled = false
    void loading.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(EXTENSION_LOAD_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await loading

    expect(manager.getLoadFailures()).toEqual([
      expect.objectContaining({ name: '@janhq/stuck-extension', reason: 'timeout' }),
    ])
    // The status line named what startup was still waiting for.
    expect(steps.some((label) => label.includes('stuck'))).toBe(true)
  })

  it('logs an extension that finishes after startup gave up on it', async () => {
    vi.useFakeTimers()
    let finish: () => void = () => {}
    manager.register(
      '@janhq/slow-extension',
      fake(() => new Promise<void>((resolve) => (finish = resolve)))
    )
    const loading = manager.load()
    await vi.advanceTimersByTimeAsync(EXTENSION_LOAD_TIMEOUT_MS)
    await loading
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(logs.some((line) => line.includes('slow-extension finished loading late'))).toBe(true)
  })

  it('registers the others when one extension fails to import', async () => {
    getActiveExtensions.mockResolvedValue([
      { url: 'ok.js', name: '@janhq/ok-extension', extensionInstance: fake(() => {}) },
      { url: 'missing.js', name: '@janhq/missing-extension' },
    ])
    const activate = vi.spyOn(manager, 'activateExtension')
    activate.mockImplementation(async (extension: Extension) => {
      if (extension.name === '@janhq/missing-extension') {
        throw new Error('Failed to fetch dynamically imported module')
      }
      manager.register(extension.name, extension.extensionInstance!)
    })

    await expect(manager.registerActive()).resolves.toBeUndefined()

    expect(manager.getByName('@janhq/ok-extension')).toBeDefined()
    expect(manager.getLoadFailures()).toEqual([
      expect.objectContaining({ name: '@janhq/missing-extension', reason: 'error' }),
    ])
  })

  it('starts with no extensions when the list cannot be read', async () => {
    getActiveExtensions.mockRejectedValue(new Error('extensions.json is corrupt'))
    await expect(manager.registerActive()).resolves.toBeUndefined()
    expect(manager.listExtensions()).toEqual([])
    expect(manager.getLoadFailures()[0]).toMatchObject({
      name: 'extensions.json',
      message: 'extensions.json is corrupt',
    })
  })
})
