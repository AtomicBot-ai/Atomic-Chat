/**
 * How the chat composer is laid out: its width, its height, and which feature
 * chips the "+" menu has added to its toolbar.
 *
 * Width and height are bounded so a drag can never make the composer unusable
 * or push it off the window. Persisted: it is how the user set their window up.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const COMPOSER_MIN_WIDTH = 420
export const COMPOSER_MAX_WIDTH = 1100
export const COMPOSER_DEFAULT_WIDTH = 768 // Tailwind max-w-3xl
export const COMPOSER_MIN_ROWS = 2
export const COMPOSER_MAX_ROWS = 40
export const MENU_MIN_HEIGHT = 160
export const MENU_MAX_HEIGHT = 640
export const MENU_DEFAULT_HEIGHT = 288

export type ComposerChip = 'prompts' | 'skills'

type ComposerLayoutState = {
  /** `null` = the default width. */
  width: number | null
  rows: number
  chips: ComposerChip[]
  /** Height of the pill menus (Prompts, Skills); they share one size. */
  menuHeight: number
  setMenuHeight: (height: number) => void
  setSize: (width: number | null, rows: number) => void
  resetSize: () => void
  toggleChip: (chip: ComposerChip) => void
  removeChip: (chip: ComposerChip) => void
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export const useComposerLayout = create<ComposerLayoutState>()(
  persist(
    (set) => ({
      width: null,
      rows: COMPOSER_MIN_ROWS,
      chips: [],
      menuHeight: MENU_DEFAULT_HEIGHT,
      setMenuHeight: (height) =>
        set({ menuHeight: clamp(Math.round(height), MENU_MIN_HEIGHT, MENU_MAX_HEIGHT) }),
      setSize: (width, rows) =>
        set({
          width:
            width === null
              ? null
              : clamp(Math.round(width), COMPOSER_MIN_WIDTH, COMPOSER_MAX_WIDTH),
          rows: clamp(Math.round(rows), COMPOSER_MIN_ROWS, COMPOSER_MAX_ROWS),
        }),
      resetSize: () => set({ width: null, rows: COMPOSER_MIN_ROWS }),
      toggleChip: (chip) =>
        set((state) => ({
          chips: state.chips.includes(chip)
            ? state.chips.filter((entry) => entry !== chip)
            : [...state.chips, chip],
        })),
      removeChip: (chip) =>
        set((state) => ({ chips: state.chips.filter((entry) => entry !== chip) })),
    }),
    { name: 'radium-composer-layout' }
  )
)
