import { useMemo, useState } from 'react'
import { IconLoader, IconRefresh } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import Capabilities from '@/containers/Capabilities'
import { Card, CardItem } from '@/containers/Card'
import { DialogAddModel } from '@/containers/dialogs/AddModel'
import { DialogDeleteModel } from '@/containers/dialogs/DeleteModel'
import { DialogEditModel } from '@/containers/dialogs/EditModel'
import { FavoriteModelAction } from '@/containers/FavoriteModelAction'
import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isProviderConnected } from '@/lib/cloud-providers'
import { getModelDisplayName } from '@/lib/utils'
import { isKnownProvider } from '@/stores/provider-registry-store'

type CloudModelsCardProps = {
  provider: ProviderObject
  refreshing: boolean
  onRefresh: () => void
}

/**
 * The provider's model list.
 *
 * `provider.models` *is* the selected set — there is no separate selection to
 * store, so this stays add/remove rather than the checkbox multi-select the
 * reference design uses. Removal goes through `DialogDeleteModel`, which is
 * deliberately a per-model confirmation: `deleteModel` tombstones the id for
 * every provider, permanently, so a bulk "clear" must never exist here.
 */
export function CloudModelsCard({
  provider,
  refreshing,
  onRefresh,
}: CloudModelsCardProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const models = useMemo(
    () => provider.models.filter((m) => m.id !== EMBEDDING_MODEL_ID),
    [provider.models]
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return models
    return models.filter((model) =>
      `${model.id} ${getModelDisplayName(model)}`.toLowerCase().includes(needle)
    )
  }, [models, query])

  // The star is only meaningful once the provider can actually serve — same
  // rule the Settings model list applies.
  const showFavorite = !isKnownProvider(provider.provider) || isProviderConnected(provider)

  const countLabel =
    models.length === 0
      ? t('cloud:models.countNone')
      : models.length === 1
        ? t('cloud:models.countOne')
        : t('cloud:models.count', { count: models.length })

  return (
    <Card
      header={
        <div className="mb-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-studio text-base font-medium text-foreground">
                {t('providers:models')}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">{countLabel}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onRefresh}
                disabled={refreshing}
              >
                {refreshing ? (
                  <IconLoader
                    size={16}
                    className="animate-spin text-muted-foreground"
                  />
                ) : (
                  <IconRefresh size={16} className="text-muted-foreground" />
                )}
                <span>
                  {refreshing
                    ? t('providers:refreshing')
                    : t('cloud:models.reload')}
                </span>
              </Button>
              <DialogAddModel provider={provider} />
            </div>
          </div>
          {models.length > 0 && (
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('cloud:models.searchPlaceholder')}
            />
          )}
        </div>
      }
    >
      {models.length === 0 ? (
        <p className="py-2 text-muted-foreground">
          {t('providers:noModelFoundDesc')}
        </p>
      ) : visible.length === 0 ? (
        <p className="py-2 text-muted-foreground">
          {t('cloud:models.noResults')}
        </p>
      ) : (
        visible.map((model) => (
          <CardItem
            key={model.id}
            title={
              <div className="flex items-center gap-2">
                <h3
                  className="line-clamp-1 max-w-[16rem] font-medium lg:max-w-[24rem] xl:max-w-none"
                  title={model.id}
                >
                  {getModelDisplayName(model)}
                </h3>
                <Capabilities capabilities={model.capabilities || []} />
              </div>
            }
            actions={
              <div className="flex items-center gap-0.5">
                {/* The slot is reserved either way so entering a key doesn't
                    shift the icons next to it. */}
                <div
                  aria-hidden={!showFavorite}
                  className={
                    showFavorite ? undefined : 'invisible pointer-events-none'
                  }
                >
                  <FavoriteModelAction model={model} />
                </div>
                <DialogEditModel provider={provider} modelId={model.id} />
                <DialogDeleteModel provider={provider} modelId={model.id} />
              </div>
            }
          />
        ))
      )}
    </Card>
  )
}
