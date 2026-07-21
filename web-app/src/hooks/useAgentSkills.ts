import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteAgentSkill,
  getAgentSkill,
  listAgentSkills,
  refreshAgentSkills,
  setAgentSkillEnabled,
  type AgentSkill,
  type AgentSkillDetail,
} from '@/services/agent/skills'

export function useAgentSkills(enabled = true) {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [selected, setSelected] = useState<AgentSkillDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const selectedNameRef = useRef<string | null>(null)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const next = refresh
        ? await refreshAgentSkills()
        : await listAgentSkills()
      setSkills(next)
      const selectedName = selectedNameRef.current
      if (selectedName && next.some((skill) => skill.name === selectedName)) {
        if (refresh) {
          setSelected(await getAgentSkill(selectedName))
        }
      } else if (selectedName) {
        selectedNameRef.current = null
        setSelected(null)
      }
    } catch (reason) {
      setError(String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void load()
  }, [enabled, load])

  const select = useCallback(async (name: string) => {
    setError(null)
    try {
      const detail = await getAgentSkill(name)
      selectedNameRef.current = name
      setSelected(detail)
    } catch (reason) {
      setError(String(reason))
    }
  }, [])

  const setEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      await setAgentSkillEnabled(name, enabled)
      await load()
      if (selected?.name === name) {
        await select(name)
      }
    },
    [load, select, selected?.name]
  )

  const remove = useCallback(
    async (name: string) => {
      await deleteAgentSkill(name)
      if (selectedNameRef.current === name) {
        selectedNameRef.current = null
      }
      setSelected((current) => (current?.name === name ? null : current))
      await load()
    },
    [load]
  )

  return {
    skills,
    selected,
    loading,
    error,
    load,
    select,
    setEnabled,
    remove,
  }
}
