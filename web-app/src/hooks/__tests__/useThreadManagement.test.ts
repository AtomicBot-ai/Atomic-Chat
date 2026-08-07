import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectsService } from '@/services/projects/types'

const projects = [
  { id: 'project-1', name: 'First', updated_at: 2 },
  { id: 'project-2', name: 'Second', updated_at: 1 },
]

let getProjects: ReturnType<typeof vi.fn>

// The initial projects read is memoised at module level, so every test needs a
// fresh module graph — including a service hub seeded into that same graph.
const loadModule = async () => {
  vi.resetModules()
  const { seedServiceHub } = await import('@/test/service-hub')
  seedServiceHub({ projects: { getProjects } as unknown as ProjectsService })
  return import('@/hooks/useThreadManagement')
}

describe('useThreadManagement', () => {
  beforeEach(() => {
    getProjects = vi.fn().mockResolvedValue(projects)
  })

  it('reads projects from the service once and publishes them to the store', async () => {
    const { ensureProjectsLoaded, useThreadManagementStore } =
      await loadModule()

    await ensureProjectsLoaded()
    await ensureProjectsLoaded()

    expect(getProjects).toHaveBeenCalledTimes(1)
    expect(useThreadManagementStore.getState().folders).toEqual(projects)
  })

  it('does not multiply the projects read across consumers', async () => {
    const { useThreadManagement } = await loadModule()

    // A sidebar full of rows mounts one consumer each; they must share a single
    // read rather than issuing one IPC per row.
    const hooks = [
      renderHook(() => useThreadManagement()),
      renderHook(() => useThreadManagement()),
      renderHook(() => useThreadManagement()),
    ]
    await vi.waitFor(() =>
      expect(hooks[0].result.current.folders).toEqual(projects)
    )

    hooks.forEach((hook) => expect(hook.result.current.folders).toEqual(projects))
    expect(getProjects.mock.calls).toEqual([[]])
    hooks.forEach((hook) => hook.unmount())
  })

  it('lets a later consumer retry after a failed read', async () => {
    getProjects.mockRejectedValueOnce(new Error('projects unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { ensureProjectsLoaded, useThreadManagementStore } =
      await loadModule()

    await ensureProjectsLoaded()
    expect(useThreadManagementStore.getState().folders).toEqual([])

    await ensureProjectsLoaded()

    expect(getProjects).toHaveBeenCalledTimes(2)
    expect(useThreadManagementStore.getState().folders).toEqual(projects)
  })

  it('exposes the raw store so consumers can subscribe with a selector', async () => {
    const { useThreadManagementStore } = await loadModule()

    useThreadManagementStore.setState({ folders: projects })
    const { result } = renderHook(() =>
      useThreadManagementStore((state) => state.folders)
    )

    expect(result.current).toEqual(projects)
  })
})
