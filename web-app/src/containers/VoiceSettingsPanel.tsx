import { useCallback, useEffect, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { IconRefresh } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import { VoicePermissionBlock } from '@/containers/dialogs/VoiceSetupDialog'
import VoiceModelCard from '@/containers/VoiceModelCard'
import {
  VOICE_LANGUAGES,
  VOICE_MODEL_BYTES,
  VOICE_MODEL_NAME,
  type VoiceLanguage,
} from '@/constants/voice'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useVoiceInput } from '@/hooks/useVoiceInput'
import { useVoiceModel } from '@/hooks/useVoiceModel'
import { useVoiceSetting } from '@/hooks/useVoiceSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { VoiceInputDevice } from '@/services/voice/types'

const PERMISSION_LABEL = {
  granted: 'settings:voice.permissionGranted',
  denied: 'settings:voice.permissionDenied',
  undetermined: 'settings:voice.permissionPrompt',
  unsupported: 'settings:voice.permissionUnsupported',
  unknown: 'settings:voice.permissionPrompt',
} as const

/**
 * Voice input settings. Renders no page chrome, matching `LocalApiServerPanel`,
 * so it stays embeddable.
 */
export function VoiceSettingsPanel() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { installed } = useVoiceModel()

  const permission = useVoiceInput((state) => state.permission)
  const openSetup = useVoiceInput((state) => state.openSetup)

  const {
    inputDeviceId,
    setInputDeviceId,
    languageHint,
    setLanguageHint,
    liveTranscription,
    setLiveTranscription,
    unloadChatModelWhileDictating,
    setUnloadChatModelWhileDictating,
  } = useVoiceSetting()

  const [devices, setDevices] = useState<VoiceInputDevice[]>([])
  const [loadingDevices, setLoadingDevices] = useState(false)

  const refreshDevices = useCallback(async () => {
    setLoadingDevices(true)
    try {
      setDevices(await serviceHub.voice().listInputDevices())
    } catch {
      // Enumeration can legitimately fail (no audio host, permission not yet
      // granted). An empty list already says "no microphones found".
      setDevices([])
    } finally {
      setLoadingDevices(false)
    }
  }, [serviceHub])

  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  const selectedDevice = devices.find((device) => device.id === inputDeviceId)
  const deviceLabel =
    selectedDevice?.name ?? t('settings:voice.deviceSystemDefault')

  const languageLabel = (value: VoiceLanguage) =>
    value === 'auto' ? t('settings:voice.languageAuto') : value.toUpperCase()

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">{t('settings:voice.subtitle')}</p>

      <Card title={t('settings:voice.modelTitle')}>
        <CardItem
          title={VOICE_MODEL_NAME}
          description={
            installed
              ? t('settings:voice.modelDescription', {
                  size: `${(VOICE_MODEL_BYTES / 1024 ** 3).toFixed(2)} GB`,
                })
              : t('settings:voice.modelMissing')
          }
          actions={<VoiceModelCard variant="settings" />}
        />
      </Card>

      <Card title={t('settings:voice.microphoneTitle')}>
        <CardItem
          title={t('settings:voice.permission')}
          actions={
            <span
              className={cn(
                'text-xs font-medium',
                permission === 'granted' &&
                  'text-emerald-600 dark:text-emerald-400',
                permission === 'denied' && 'text-destructive',
                (permission === 'undetermined' ||
                  permission === 'unknown' ||
                  permission === 'unsupported') &&
                  'text-muted-foreground'
              )}
            >
              {t(PERMISSION_LABEL[permission])}
            </span>
          }
          descriptionOutside={
            permission === 'denied' ? <VoicePermissionBlock /> : undefined
          }
        />

        <CardItem
          title={t('settings:voice.device')}
          description={t('settings:voice.deviceDescription')}
          actions={
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-56 justify-between"
                    disabled={loadingDevices}
                  >
                    <span className="truncate">
                      {devices.length === 0 && !loadingDevices
                        ? t('settings:voice.deviceNone')
                        : deviceLabel}
                    </span>
                    <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    className={cn(
                      'cursor-pointer my-0.5',
                      inputDeviceId === null && 'bg-secondary-foreground/8'
                    )}
                    onClick={() => setInputDeviceId(null)}
                  >
                    {t('settings:voice.deviceSystemDefault')}
                  </DropdownMenuItem>
                  {devices.map((device) => (
                    <DropdownMenuItem
                      key={device.id ?? device.name}
                      className={cn(
                        'cursor-pointer my-0.5',
                        inputDeviceId === device.id &&
                          'bg-secondary-foreground/8'
                      )}
                      onClick={() => setInputDeviceId(device.id)}
                    >
                      <span className="truncate">{device.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('settings:voice.refreshDevices')}
                onClick={() => void refreshDevices()}
              >
                <IconRefresh size={16} className="text-muted-foreground" />
              </Button>
            </div>
          }
        />
      </Card>

      <Card title={t('settings:voice.transcriptionTitle')}>
        <CardItem
          title={t('settings:voice.language')}
          description={t('settings:voice.languageDescription')}
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-40 justify-between"
                >
                  {languageLabel(languageHint)}
                  <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {VOICE_LANGUAGES.map((value) => (
                  <DropdownMenuItem
                    key={value}
                    className={cn(
                      'cursor-pointer my-0.5',
                      languageHint === value && 'bg-secondary-foreground/8'
                    )}
                    onClick={() => setLanguageHint(value)}
                  >
                    {languageLabel(value)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />

        <CardItem
          title={t('settings:voice.liveMode')}
          description={t('settings:voice.liveModeDescription')}
          actions={
            <Switch
              checked={liveTranscription}
              onCheckedChange={setLiveTranscription}
            />
          }
        />

        <CardItem
          title={t('settings:voice.unloadChatModel')}
          description={t('settings:voice.unloadChatModelDescription')}
          actions={
            <Switch
              checked={unloadChatModelWhileDictating}
              onCheckedChange={setUnloadChatModelWhileDictating}
            />
          }
        />
      </Card>

      <Card title={t('settings:voice.setupTitle')}>
        <CardItem
          title={t('settings:voice.runSetupAgain')}
          description={t('settings:voice.runSetupAgainDescription')}
          actions={
            <Button variant="outline" size="sm" onClick={() => openSetup(0)}>
              {t('settings:voice.runSetupAgain')}
            </Button>
          }
        />
      </Card>
    </div>
  )
}
