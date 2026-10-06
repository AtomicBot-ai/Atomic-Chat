import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

import ChangeDataFolderLocation from '../ChangeDataFolderLocation'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'
import type { EnvironmentSnapshot } from '@/services/managed-environment/types'

const environment = (overrides: Partial<EnvironmentSnapshot>): EnvironmentSnapshot => ({
  schema_version: 1,
  environment_id: 'default',
  instance_id: 'core-a',
  revision: 1,
  executor: 'wsl-docker',
  availability: 'supported',
  gpus: [],
  blockers: [],
  selinux: null,
  installations: [],
  active_operation_id: null,
  minimum_app_version: null,
  ...overrides,
})

function seed(env: EnvironmentSnapshot) {
  useManagedEnvironmentStore
    .getState()
    .applySnapshot({ instance_id: 'core-a', environments: [env], environment_operations: [] })
}

function open() {
  render(
    <ChangeDataFolderLocation
      currentPath="C:\\Users\\ann\\AppData\\Roaming\\Atomic Chat\\data"
      newPath="D:\\AtomicChat"
      onConfirm={() => {}}
      open
      onOpenChange={() => {}}
    >
      <button>change</button>
    </ChangeDataFolderLocation>
  )
}

describe('ChangeDataFolderLocation', () => {
  beforeEach(() => useManagedEnvironmentStore.getState().reset())

  it('says TensorRT-LLM models stay in the WSL distribution and are not moved (change add-tensorrt-llm-windows)', () => {
    // spec "Смена папки данных".
    seed(environment({ distribution: { name: 'AtomicChat', path: 'C:\\wsl\\AtomicChat', size_bytes: 1 } }))
    open()

    expect(screen.getByText(/settings:dialogs.changeDataFolder.tensorrtModels/)).toHaveTextContent('AtomicChat')
  })

  it('says nothing about TensorRT-LLM where there is no distribution of Atomic Chat', () => {
    seed(environment({ executor: 'linux-docker' }))
    open()

    expect(screen.getByText('settings:dialogs.changeDataFolder.newLocation')).toBeInTheDocument()
    expect(screen.queryByText(/settings:dialogs.changeDataFolder.tensorrtModels/)).not.toBeInTheDocument()
  })
})
