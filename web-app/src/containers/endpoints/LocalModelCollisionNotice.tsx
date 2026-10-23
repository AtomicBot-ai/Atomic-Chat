import { TriangleAlert } from 'lucide-react'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { localModelCollisions } from '@/lib/local-model-collisions'
import { getProviderTitle } from '@/lib/utils'
import { servedModelSelection } from '@/utils/serverModelSelection'

/**
 * A non-blocking note in the endpoint dialog and on the expanded endpoint
 * card: the endpoint lists a model id
 * a local engine also lists, and this is where the Local API Server sends
 * requests for it (AC-03). Renders nothing when there is no such id.
 */
export function LocalModelCollisionNotice({
  endpoint,
  modelIds,
}: {
  /** The endpoint's provider name. */
  endpoint: string
  modelIds: string[]
}) {
  const { t } = useTranslation()
  const providers = useModelProvider((state) => state.providers)
  const lastServerModels = useLocalApiServer((state) => state.lastServerModels)
  const defaultModel = useLocalApiServer(
    (state) => state.defaultModelLocalApiServer
  )
  const collisions = localModelCollisions(
    modelIds,
    providers,
    servedModelSelection({
      lastServerModels,
      defaultModelLocalApiServer: defaultModel,
    })
  )
  if (collisions.length === 0) return null

  return (
    <div
      role="status"
      className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
    >
      <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />
      <ul className="min-w-0 space-y-1 break-words">
        {collisions.map(({ model, served }) => (
          <li key={model}>
            {served && served !== endpoint
              ? t('endpoints:dialog.localModelCollision', {
                  model,
                  provider: getProviderTitle(served),
                })
              : served === endpoint
                ? t('endpoints:dialog.localModelCollisionEndpoint', { model })
                : t('endpoints:dialog.localModelCollisionUnselected', {
                    model,
                  })}
          </li>
        ))}
      </ul>
    </div>
  )
}
