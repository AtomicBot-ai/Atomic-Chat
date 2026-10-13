/**
 * The settings last used for each media task on the Media page.
 *
 * Chat generates images and video with "the last used settings", so the Media
 * page is where you fine-tune and chat is where you just ask. Only what the
 * user tuned is kept - model, provider, device and parameters - and never the
 * prompt, which belongs to each request. The seed is dropped for the same
 * reason: reusing it would make every chat image identical.
 *
 * Persisted in `localStorage`: a UI preference, not library data.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { NormalizedMediaRequest } from '@/services/media/contract'

export type MediaLastUsed = {
  provider_id: string
  model_id: string
  params: Record<string, unknown>
  device?: string
}

type MediaLastUsedState = {
  byTask: Record<string, MediaLastUsed>
  record: (request: NormalizedMediaRequest) => void
}

export const useMediaLastUsedStore = create<MediaLastUsedState>()(
  persist(
    (set) => ({
      byTask: {},
      record: (request) => {
        const params = { ...request.params }
        delete params.prompt
        delete params.seed
        set((state) => ({
          byTask: {
            ...state.byTask,
            [request.task]: {
              provider_id: request.provider_id,
              model_id: request.model_id,
              params,
              ...(request.device ? { device: request.device } : {}),
            },
          },
        }))
      },
    }),
    { name: 'radium-media-last-used' }
  )
)
