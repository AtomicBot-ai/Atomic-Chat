/**
 * The media library, as a store React can subscribe to.
 *
 * Thin on purpose. All the behaviour - schema versioning, atomic writes,
 * degrading gracefully on a damaged index - lives in
 * `services/media/library.ts`, which is testable without React, without Tauri
 * and without a disk. This file is the binding: the real filesystem, the real
 * data folder, and a Zustand store over the result.
 *
 * Nothing here is persisted to `localStorage`. The library's durable copy is
 * `index.json` on disk; a second, stale copy in browser storage would only
 * ever disagree with it.
 */

import { fs as coreFs } from '@janhq/core'
import { create } from 'zustand'

import { getServiceHub } from '@/hooks/useServiceHub'

import type { MediaAsset, MediaFileSystem } from '@/services/media/assets'
import {
  createMediaLibrary,
  type MediaLibrary,
} from '@/services/media/library'

/**
 * `MediaFileSystem` over `@janhq/core`'s bridge.
 *
 * The port exists because that bridge is untyped (`(...args: any[])`) and only
 * available inside the app shell. Keeping the surface this small is what lets
 * every rule in `library.ts` and `assets.ts` be tested against a Map.
 */
export const coreMediaFileSystem: MediaFileSystem = {
  // Both separators are accepted by the Rust side; forward slashes keep the
  // joined path readable in logs on every platform.
  join: (...parts) => parts.filter(Boolean).join('/'),

  async mkdir(path) {
    await coreFs.mkdir(path)
  },

  async exists(path) {
    return Boolean(await coreFs.existsSync(path))
  },

  async writeBytes(path, bytes) {
    // `fs.writeBlob` was used here before, but no Rust command ever backed it,
    // so every save threw and no generation reached the library. Base64 over a
    // dedicated binary-write command is what actually works. Chunked, because
    // spreading a multi-megabyte array into String.fromCharCode overflows the
    // call stack.
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    await getServiceHub()
      .core()
      .invoke('write_binary_file', { path, dataBase64: btoa(binary) })
  },

  async readText(path) {
    return (await coreFs.readFileSync(path, 'utf-8')) as string
  },

  async rename(from, to) {
    await coreFs.mv(from, to)
  },

  async remove(path) {
    // `fs.unlinkSync` had no Rust command behind it either.
    await getServiceHub().core().invoke('remove_file', { path })
  },

  async size(path) {
    const stat = await coreFs.fileStat(path)
    return stat?.size ?? 0
  },
}

/** The data folder, from AppConfiguration. Never hardcoded - see DEVELOP.md. */
export async function mediaDataFolder(): Promise<string> {
  const configuration = await window.core?.api?.getAppConfigurations()
  const folder = (configuration as { data_folder?: string } | undefined)
    ?.data_folder
  if (!folder) {
    throw new Error(
      'No data_folder in AppConfiguration; refusing to guess where media belongs.'
    )
  }
  return folder
}

type MediaLibraryState = {
  assets: MediaAsset[]
  loading: boolean
  loaded: boolean
  /** True when index.json came from a newer build and must not be written. */
  readOnly: boolean

  load: () => Promise<void>
  add: (assets: MediaAsset[]) => Promise<void>
  remove: (assetId: string) => Promise<void>
  setFavourite: (assetId: string, favourite: boolean) => Promise<void>
  rename: (assetId: string, name: string) => Promise<void>
}

/**
 * One library for the app, built lazily so that importing this module does not
 * reach for `window.core` at module-evaluation time - which is exactly what
 * breaks a test file that only wanted the types.
 */
let library: MediaLibrary | undefined

function instance(): MediaLibrary {
  if (!library) {
    library = createMediaLibrary({
      fs: coreMediaFileSystem,
      dataFolder: mediaDataFolder,
      warn: (message, cause) => console.warn(`[media-library] ${message}`, cause),
    })
  }
  return library
}

/** Test seam: replace the backing library. */
export function __setMediaLibrary(next: MediaLibrary | undefined) {
  library = next
}

export const useMediaLibraryStore = create<MediaLibraryState>()((set) => {
  const sync = () =>
    set({ assets: [...instance().list()], readOnly: instance().readOnly() })

  return {
    assets: [],
    loading: false,
    loaded: false,
    readOnly: false,

    async load() {
      set({ loading: true })
      try {
        await instance().load()
        sync()
        set({ loaded: true })
      } finally {
        set({ loading: false })
      }
    },

    async add(assets) {
      await instance().add(assets)
      sync()
    },

    async remove(assetId) {
      await instance().remove(assetId)
      sync()
    },

    async setFavourite(assetId, favourite) {
      await instance().setFavourite(assetId, favourite)
      sync()
    },

    async rename(assetId, name) {
      await instance().rename(assetId, name)
      sync()
    },
  }
})
