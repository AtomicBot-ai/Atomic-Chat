/**
 * Whether the chat composer sends to the model or to media generation.
 *
 * `null` is ordinary chat. A task id makes the next send generate that kind of
 * media with the Media page's last used settings and show it in the thread.
 */

import { create } from 'zustand'

export type ChatMediaTask = 'text_to_image' | 'text_to_video'

type MediaChatModeState = {
  task: ChatMediaTask | null
  setTask: (task: ChatMediaTask | null) => void
}

export const useMediaChatMode = create<MediaChatModeState>()((set) => ({
  task: null,
  setTask: (task) => set({ task }),
}))
