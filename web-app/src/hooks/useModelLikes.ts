import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const MODEL_LIKES_STORAGE_KEY = 'atomic-model-likes'

type ModelLikesState = {
  /** Hub model ids (`model_name`) the user marked with a heart, oldest first. */
  liked: string[]
  /** The Hub's "Liked models" filter: for this launch only, like the format. */
  onlyLiked: boolean
  toggle: (id: string) => void
  setOnlyLiked: (value: boolean) => void
}

/**
 * Hearts on Hub rows. A heart is the user's own bookmark, kept on this device;
 * it has nothing to do with Hugging Face's like count, which the Likes sort reads.
 */
export const useModelLikes = create<ModelLikesState>()(
  persist(
    (set) => ({
      liked: [],
      onlyLiked: false,
      toggle: (id) =>
        set((state) => ({
          liked: state.liked.includes(id)
            ? state.liked.filter((item) => item !== id)
            : [...state.liked, id],
        })),
      setOnlyLiked: (onlyLiked) => set({ onlyLiked }),
    }),
    {
      name: MODEL_LIKES_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ liked }) => ({ liked }),
    }
  )
)
