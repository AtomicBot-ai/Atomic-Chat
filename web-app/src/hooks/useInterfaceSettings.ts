import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { useTheme } from './useTheme'

export type FontSize = '14px' | '15px' | '16px' | '18px' | '20px'

//* Единственный пресет: нейтральный сайдбар без фиолетового/брендового акцента (--primary из index.css)
const ACCENT_THUMB = '#737373'
export const ACCENT_COLORS = [
  {
    name: 'Primary',
    value: 'primary',
    thumb: ACCENT_THUMB,
    sidebar: { light: '#f5f5f5', dark: '#2c2c2c' },
  },
] as const

export type AccentColorValue = (typeof ACCENT_COLORS)[number]['value']
const DEFAULT_ACCENT_COLOR: AccentColorValue = 'primary'

const applyAccentColorToDOM = (colorValue: string, isDark: boolean) => {
  const color = ACCENT_COLORS.find((c) => c.value === colorValue)
  if (!color) return

  const root = document.documentElement
  const sidebarColor = isDark ? color.sidebar.dark : color.sidebar.light

  root.style.setProperty('--sidebar', sidebarColor)
}

interface InterfaceSettingsState {
  fontSize: FontSize
  accentColor: AccentColorValue
  setFontSize: (size: FontSize) => void
  setAccentColor: (color: AccentColorValue) => void
  resetInterface: () => void
}

type InterfaceSettingsPersistedSlice = Omit<
  InterfaceSettingsState,
  'resetInterface' | 'setFontSize' | 'setAccentColor'
>

export const fontSizeOptions = [
  { label: 'Small', value: '14px' as FontSize },
  { label: 'Medium', value: '16px' as FontSize },
  { label: 'Large', value: '18px' as FontSize },
  { label: 'Extra Large', value: '20px' as FontSize },
]

// Default interface settings
const defaultFontSize: FontSize = '16px'

const createDefaultInterfaceValues = (): InterfaceSettingsPersistedSlice => {
  return {
    fontSize: defaultFontSize,
    accentColor: DEFAULT_ACCENT_COLOR,
  }
}

const interfaceStorage = createJSONStorage<InterfaceSettingsState>(() =>
  localStorage
)

export const useInterfaceSettings = create<InterfaceSettingsState>()(
  persist(
    (set) => {
      const defaultState = createDefaultInterfaceValues()
      return {
        ...defaultState,
        resetInterface: () => {
          const { isDark } = useTheme.getState()

          // Reset font size
          document.documentElement.style.setProperty(
            '--font-size-base',
            defaultFontSize
          )

          // Reset accent color preset
          applyAccentColorToDOM(DEFAULT_ACCENT_COLOR, isDark)

          // Update state
          set({
            fontSize: defaultFontSize,
            accentColor: DEFAULT_ACCENT_COLOR,
          })
        },

        setAccentColor: (color: AccentColorValue) => {
          const colorExists = ACCENT_COLORS.find((c) => c.value === color)
          if (!colorExists) return

          const { isDark } = useTheme.getState()
          applyAccentColorToDOM(color, isDark)
          set({ accentColor: color })
        },

        setFontSize: (size: FontSize) => {
          // Update CSS variable
          document.documentElement.style.setProperty('--font-size-base', size)
          // Update state
          set({ fontSize: size })
        },
      }
    },
    {
      name: localStorageKey.settingInterface,
      storage: interfaceStorage,
      // Apply settings when hydrating from storage
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Migrate old font size value '15px' to '16px'
          if ((state.fontSize as FontSize) === '15px') {
            state.fontSize = '16px'
          }

          // Migrate accent: если сохранённый пресет больше не существует — применить единственный
          const colorExists = ACCENT_COLORS.some((c) => c.value === state.accentColor)
          if (!colorExists) {
            state.accentColor = DEFAULT_ACCENT_COLOR
          }

          // Apply font size from storage
          document.documentElement.style.setProperty(
            '--font-size-base',
            state.fontSize
          )

          const { isDark } = useTheme.getState()
          const accentColorValue = state.accentColor || DEFAULT_ACCENT_COLOR
          applyAccentColorToDOM(accentColorValue, isDark)
        }

        return state
      },
    }
  )
)

// Subscribe to theme changes to update accent color sidebar variant
let prevIsDark = useTheme.getState().isDark
useTheme.subscribe((state) => {
  if (state.isDark !== prevIsDark) {
    prevIsDark = state.isDark
    const { accentColor } = useInterfaceSettings.getState()
    applyAccentColorToDOM(accentColor, state.isDark)
  }
})
