import { ChevronsUpDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { groupCloudProviders, isProviderConnected } from '@/lib/cloud-providers'
import { cn, getProviderTitle } from '@/lib/utils'

type CloudProviderSelectProps = {
  /** The full provider list from `useModelProvider` — filtered here. */
  providers: ProviderObject[]
  selected: ProviderObject | undefined
  onSelect: (providerName: string) => void
  /** Opens the "custom OpenAI-compatible provider" dialog. */
  onAddCustom: () => void
}

/**
 * The connection picker: one control that names the provider and says whether
 * it is set up, instead of a second list of "connected" entries.
 *
 * Two groups either side of a separator — self-hosted endpoints (Ollama, a
 * custom loopback server) above, key-taking clouds below. Grouping is by
 * property, so a future LM-Studio-style registry entry lands correctly with no
 * change here.
 */
export function CloudProviderSelect({
  providers,
  selected,
  onSelect,
  onAddCustom,
}: CloudProviderSelectProps) {
  const { t } = useTranslation()
  const { selfHosted, hosted } = groupCloudProviders(providers)

  const renderItem = (provider: ProviderObject) => (
    <DropdownMenuItem
      key={provider.provider}
      onClick={() => onSelect(provider.provider)}
      className={cn(
        'flex items-center gap-2 my-0.5',
        provider.provider === selected?.provider && 'bg-secondary/60'
      )}
    >
      <ProvidersAvatar provider={provider} className="size-4.5 shrink-0" />
      <span className="truncate">{getProviderTitle(provider.provider)}</span>
      {isProviderConnected(provider) && (
        // Same marker the settings menu and the model picker use for "this one
        // is live".
        <span
          data-testid={`cloud-connected-dot-${provider.provider}`}
          className="ml-auto size-2 shrink-0 rounded-full bg-green-500"
        />
      )}
    </DropdownMenuItem>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-full min-w-0 justify-between sm:w-80"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected && (
              <ProvidersAvatar
                provider={selected}
                className="size-4.5 shrink-0"
              />
            )}
            <span className="truncate">
              {selected
                ? getProviderTitle(selected.provider)
                : t('cloud:connection.select')}
            </span>
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
        {selfHosted.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('cloud:connection.groupSelfHosted')}
            </DropdownMenuLabel>
            {selfHosted.map(renderItem)}
          </>
        )}
        <DropdownMenuItem onClick={onAddCustom} className="my-0.5 gap-2">
          <Plus className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{t('cloud:connection.custom')}</span>
        </DropdownMenuItem>
        {hosted.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('cloud:connection.groupHosted')}
            </DropdownMenuLabel>
            {hosted.map(renderItem)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
