import { ChevronsUpDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { installableOptions } from '@/hooks/useEngineBuildSwitch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { EngineId } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

/**
 * "Install another build…" on a llama.cpp provider's page, in place of the
 * version list: only the builds this computer does not have — a catalog
 * release, or the newest of another variant (`latest/<variant>`). Picking one
 * hands it to `onPick`, which has the core download it, switch to it and
 * unload the provider's models. Switching between installed builds and
 * removing them is the installed builds list's; the active build is shown
 * there, so this control names no current value.
 */
export function InstallOtherBuild({
  engine,
  options,
  disabled = false,
  onPick,
}: {
  engine: EngineId
  /** The extension's version list (`version_backend` options). */
  options: Array<{ value: number | string; name: string }>
  disabled?: boolean
  onPick: (value: string) => void
}) {
  const { t } = useTranslation()
  const entry = useEngineVersionsStore((state) => state.engines[engine])
  const offered = installableOptions(entry, options)
  const label = t('settings:engineBuilds.installOther')

  if (offered.length === 0)
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className="w-full min-w-0 justify-between"
        data-testid={`engine-install-other-${engine}`}
        title={t('settings:engineBuilds.nothingToInstall')}
      >
        <span className="truncate">{label}</span>
      </Button>
    )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          size="sm"
          className="w-full min-w-0 justify-between"
          data-testid={`engine-install-other-${engine}`}
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-70">
        {offered.map((option) => (
          <DropdownMenuItem
            key={String(option.value)}
            className="my-1"
            onClick={() => onPick(String(option.value))}
          >
            <span>{option.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
