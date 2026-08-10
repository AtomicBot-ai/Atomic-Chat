import { useGeneralSetting, type SettingsMode } from '@/hooks/useGeneralSetting'
import { useAppTranslation } from '@/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ChevronsUpDown } from 'lucide-react'

const MODES: { value: SettingsMode; label: string }[] = [
  { value: 'base', label: 'settings:general.settingsModeBase' },
  { value: 'advanced', label: 'settings:general.settingsModeAdvanced' },
]

export default function SettingsModeSwitcher() {
  const { t } = useAppTranslation()
  const { settingsMode, setSettingsMode } = useGeneralSetting()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-36 justify-between">
          <span className="truncate">
            {t(
              MODES.find((mode) => mode.value === settingsMode)?.label ??
                'settings:general.settingsModeBase'
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        {MODES.map((mode) => (
          <DropdownMenuItem
            key={mode.value}
            className={cn(
              'cursor-pointer my-0.5',
              settingsMode === mode.value && 'bg-secondary-foreground/8'
            )}
            onClick={() => setSettingsMode(mode.value)}
          >
            {t(mode.label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
