import { useState, useCallback } from 'react'

interface HermesAgentConfig {
  model: string | null
}

const STORAGE_KEY = 'hermes-agent-model'

const defaultConfig: HermesAgentConfig = {
  model: null,
}

const loadFromStorage = (): HermesAgentConfig => {
  if (typeof window === 'undefined') return defaultConfig

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (typeof parsed === 'object' && parsed !== null && 'model' in parsed) {
        return { model: parsed.model ?? null }
      }
    }
  } catch {
    console.warn('Failed to load hermes-agent config from localStorage')
  }
  return defaultConfig
}

export function useHermesAgentModel() {
  const [config, setConfig] = useState<HermesAgentConfig>(loadFromStorage)

  const saveToStorage = useCallback((data: HermesAgentConfig) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      console.warn('Failed to save hermes-agent config to localStorage')
    }
  }, [])

  const setModel = useCallback(
    (modelId: string | null) => {
      setConfig((prev) => {
        const next = { ...prev, model: modelId }
        saveToStorage(next)
        return next
      })
    },
    [saveToStorage]
  )

  const clearModel = useCallback(() => {
    setConfig(defaultConfig)
    saveToStorage(defaultConfig)
  }, [saveToStorage])

  return {
    config,
    setModel,
    clearModel,
  }
}
