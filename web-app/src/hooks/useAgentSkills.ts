import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createAgentSkill,
  deleteAgentSkill,
  exportAgentSkill,
  getAgentSkill,
  importAgentSkill,
  listAgentSkills,
  refreshAgentSkills,
  setAgentSkillEnabled,
  updateAgentSkill,
  type AgentSkill,
  type AgentSkillDetail,
  type CreateAgentSkillRequest,
  type UpdateAgentSkillRequest,
} from '@/services/agent/skills'
import { getServiceHub } from '@/hooks/useServiceHub'

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
      const sorted = [...next].sort((left, right) =>
        left.name.localeCompare(right.name)
      )
      setSkills(sorted)
      const selectedName = selectedNameRef.current
      if (selectedName && sorted.some((skill) => skill.name === selectedName)) {
        if (refresh) {
          setSelected(await getAgentSkill(selectedName))
        }
      } else {
        const fallbackName = sorted[0]?.name ?? null
        selectedNameRef.current = fallbackName
        setSelected(fallbackName ? await getAgentSkill(fallbackName) : null)
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

  const addCreated = useCallback(
    async (request: CreateAgentSkillRequest) => {
      const detail = await createAgentSkill(request)
      selectedNameRef.current = detail.name
      setSelected(detail)
      await load()
    },
    [load]
  )

  const addImported = useCallback(
    async (sourcePath: string) => {
      const detail = await importAgentSkill(sourcePath)
      selectedNameRef.current = detail.name
      setSelected(detail)
      await load()
    },
    [load]
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

  const update = useCallback(async (request: UpdateAgentSkillRequest) => {
    const detail = await updateAgentSkill(request)
    setSkills((current) =>
      current.map((skill) =>
        skill.name === detail.name ? { ...skill, ...detail } : skill
      )
    )
    if (selectedNameRef.current === detail.name) {
      setSelected(detail)
    }
  }, [])

  const exportSkill = useCallback(async (name: string) => {
    const targetPath = await getServiceHub()
      .dialog()
      .save({
        defaultPath: `${name}.skill`,
        filters: [{ name: 'Atomic Chat Skill', extensions: ['skill'] }],
      })
    if (!targetPath) return false
    await exportAgentSkill(name, targetPath)
    return true
  }, [])

  return {
    skills,
    selected,
    loading,
    error,
    load,
    select,
    setEnabled,
    addCreated,
    addImported,
    remove,
    update,
    exportSkill,
  }
}
