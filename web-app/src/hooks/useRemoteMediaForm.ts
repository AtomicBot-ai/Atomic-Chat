import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import type { ImageSourceFile } from '@/hooks/useImageForm'
import type {
  RemoteImageOptions,
  RemoteVideoOptions,
  RemoteVideoWorkflow,
} from '@/services/media/types'

/**
 * The settings only a provider's model takes (size from its list, aspect ratio, resolution tier,
 * quality, clip length, sound), kept apart from the local form so picking a cloud model never
 * disturbs a local checkpoint's steps and size. A value a newly picked model does not offer falls
 * back to that model's default (`lib/media-capabilities.ts`).
 */
type RemoteMediaFormState = {
  image: RemoteImageOptions
  video: RemoteVideoOptions
  /** The Video page's mode with a provider's model: only theirs can start from a picture yet. */
  videoWorkflow: RemoteVideoWorkflow
  /** Image to video's first frame; this session's only, like the Images page's source. */
  firstFrame: ImageSourceFile | null
  patchImage: (patch: Partial<RemoteImageOptions>) => void
  patchVideo: (patch: Partial<RemoteVideoOptions>) => void
  setVideoWorkflow: (workflow: RemoteVideoWorkflow) => void
  setFirstFrame: (frame: ImageSourceFile | null) => void
}

export const useRemoteMediaForm = create<RemoteMediaFormState>()(
  persist(
    (set) => ({
      image: {},
      video: {},
      videoWorkflow: 'create',
      firstFrame: null,
      patchImage: (patch) =>
        set((state) => ({ image: { ...state.image, ...patch } })),
      patchVideo: (patch) =>
        set((state) => ({ video: { ...state.video, ...patch } })),
      setVideoWorkflow: (videoWorkflow) => set({ videoWorkflow }),
      setFirstFrame: (firstFrame) => set({ firstFrame }),
    }),
    {
      name: localStorageKey.remoteMediaForm,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: (state) => ({
        image: state.image,
        video: state.video,
        videoWorkflow: state.videoWorkflow,
      }),
    }
  )
)
