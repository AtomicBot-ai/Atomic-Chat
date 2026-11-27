import { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTools } from '@/hooks/useTools'
import { useThreads } from '@/hooks/useThreads'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  useInitialMessage,
  type InitialMessageFile,
} from '@/hooks/useInitialMessage'
import { usePrompt } from '@/hooks/usePrompt'
import { useAgentMode } from '@/hooks/useAgentMode'
import { resolveAgentWorkspaceRoot } from '@/services/agent/tauri'
import { servedModel } from '@/utils/servedModel'
import { useModelProvider } from '@/hooks/useModelProvider'

import { useComposerSecureEnvironment } from '@/hooks/useSecureEnvironments'
import type { ThreadFolder } from '@/services/projects/types'
import { useAssistant } from '@/hooks/useAssistant'
import { assistantForNewChat } from '@/lib/samplingParams'
import { AGENT_HOME_DRAFT } from '@/lib/pi/navigation'

export function TaskComposer({ project }: { project?: ThreadFolder }) {
  const composer = project ? 'pi-agent-project:' + project.id : AGENT_HOME_DRAFT
  useTools()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const hub = useServiceHub()
  const root = useAgentMode((s) => s.workspaces[composer]?.primaryRoot)
  const [error, setError] = useState('')
  const creating = useRef(false)
  const environment = useComposerSecureEnvironment(true, project?.id)
  const secureFolder =
    environment?.folders.find((folder) => folder.canEdit) ??
    environment?.folders[0]
  const workspaceFolder = environment
    ? secureFolder && {
        path: secureFolder.path,
        onClick: () =>
          void hub
            .opener()
            .openPath(secureFolder.path)
            .catch((e) => setError(String(e))),
      }
    : {
        path: root?.path,
        onClick: () => void choose().catch((e) => setError(String(e))),
      }
  async function choose() {
    const path = await hub.dialog().open({ directory: true, multiple: false })
    if (typeof path !== 'string') return
    const folder = { ...(await resolveAgentWorkspaceRoot(path)), canEdit: true }
    useAgentMode.getState().setPrimaryRoot(composer, folder)
    return folder
  }
  async function submit(text: string, files?: InitialMessageFile[]) {
    if (creating.current) return
    creating.current = true
    setError('')
    try {
      const folder = environment
        ? secureFolder && {
            ...(await resolveAgentWorkspaceRoot(secureFolder.path)),
            canEdit: secureFolder.canEdit,
          }
        : (root ?? (await choose()))
      if (!environment && !folder) {
        usePrompt.getState().setDraft(composer, text)
        return
      }
      const served = servedModel()
      const { selectedModel, selectedProvider } = useModelProvider.getState()
      const model = selectedModel
        ? { id: selectedModel.id, provider: selectedProvider }
        : served && { id: served.model, provider: served.provider }
      if (!model) throw new Error(t('chat:pi.modelRequired'))
      const assistant = assistantForNewChat(project?.assistantId)
      const thread = await useThreads.getState().createThread(
        model,
        text.slice(0, 80),
        assistant,
        project && {
          id: project.id,
          name: project.name,
          updated_at: project.updated_at,
        },
        false,
        {
          kind: 'agent',
          ...(useAssistant.getState().pendingAssistant === null && {
            agentAssistantOverride: true,
          }),
          agent: { cwd: environment ? '' : folder!.path },
        }
      )
      await useThreads.getState().awaitThreadPersistence(thread.id)
      useAssistant.getState().setPendingAssistant(undefined)
      const modes = useAgentMode.getState()
      if (folder) modes.setPrimaryRoot(thread.id, folder)
      for (const root of modes.workspaces[composer]?.externalRoots ?? []) {
        modes.addExternalRoot(thread.id, root)
      }
      modes.setApprovalMode(thread.id, modes.getApprovalMode(composer))
      useInitialMessage.getState().set(thread.id, { text, files })
      await navigate({
        to: '/agent/$threadId',
        params: { threadId: thread.id },
      })
    } catch (e) {
      usePrompt.getState().setDraft(composer, text)
      setError(String(e))
    } finally {
      creating.current = false
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ChatInput
        mode="agent"
        composerKey={composer}
        projectId={project?.id}
        containerClassName={project ? 'max-w-none' : undefined}
        workspaceFolder={workspaceFolder}
        onSubmit={submit}
      />
    </>
  )
}
