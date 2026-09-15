import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { RunSettingsPanel } from '@/containers/RunSettingsPanel'
import { SettingsPageLayout } from '@/containers/SettingsPageLayout'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.chat as any)({
  component: ChatSettings,
})

/**
 * Settings > Chat: the run settings (assistant, system prompt, model load
 * options, sampling) that used to open beside the chat. The chat's sliders
 * button now brings you here. The controls are the panel's own, so there is
 * one copy to maintain; they apply to the chat you came from, or to new chats.
 */
function ChatSettings() {
  return (
    <SettingsPageLayout>
      <div className="max-w-xl">
        <RunSettingsPanel />
      </div>
    </SettingsPageLayout>
  )
}
