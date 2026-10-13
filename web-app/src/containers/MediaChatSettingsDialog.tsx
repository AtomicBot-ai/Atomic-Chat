import { useEffect, useState } from 'react'
import { IconLoader2, IconPhoto, IconSparkles, IconVideo } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  chatMediaSettingsFor,
  defaultChatGenerationDeps,
  type ChatMediaOverrides,
  type ChatMediaSettings,
  type ChatMediaTaskId,
} from '@/services/media/chatGeneration'
import { useMediaChatSettings } from '@/stores/media-chat-settings-store'

const TASK_META: Record<
  ChatMediaTaskId,
  { Icon: typeof IconPhoto; titleKey: string; titleFallback: string }
> = {
  text_to_image: {
    Icon: IconPhoto,
    titleKey: 'chat:mediaSettings.imageTitle',
    titleFallback: 'Generate an image',
  },
  text_to_video: {
    Icon: IconVideo,
    titleKey: 'chat:mediaSettings.videoTitle',
    titleFallback: 'Generate a video',
  },
}

function resolutionLabel(option: { value: string | number; label?: string; width?: number; height?: number }) {
  if (option.label) return option.label
  if (typeof option.width === 'number' && typeof option.height === 'number') {
    return `${option.width} × ${option.height}`
  }
  return String(option.value)
}

function optionLabel(option: { value: string | number; label?: string }) {
  return option.label ?? String(option.value)
}

export type MediaChatSettingsDialogProps = {
  onConfirm: (
    task: ChatMediaTaskId,
    text: string,
    overrides: ChatMediaOverrides
  ) => void | Promise<void>
  /** Runs when the popup is dismissed without generating. */
  onCancel?: () => void
}

/**
 * Pops up when the composer is in media mode and the user sends. Offers
 * "use last used settings" (the default) or an explicit resolution — and,
 * for video, a length — before the generation runs.
 */
const MediaChatSettingsDialog = ({
  onConfirm,
  onCancel,
}: MediaChatSettingsDialogProps) => {
  const { t } = useTranslation()
  const pending = useMediaChatSettings((state) => state.pending)
  const close = useMediaChatSettings((state) => state.close)

  const dismiss = () => {
    onCancel?.()
    close()
  }

  const [settings, setSettings] = useState<ChatMediaSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [useLastUsed, setUseLastUsed] = useState(true)
  const [resolution, setResolution] = useState<string>('')
  const [lengthSeconds, setLengthSeconds] = useState<number | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!pending) return
    let cancelled = false
    setSettings(null)
    setError(null)
    setSubmitting(false)
    ;(async () => {
      try {
        const deps = await defaultChatGenerationDeps()
        if (Object.keys(deps.capabilities()).length === 0) await deps.refresh()
        const next = chatMediaSettingsFor(pending.task, deps)
        if (cancelled) return
        setSettings(next)
        setUseLastUsed(next.lastUsed !== undefined)
        setResolution(
          String(
            next.highestResolution ??
              next.defaults.resolution ??
              next.resolutionOptions[0]?.value ??
              ''
          )
        )
        const length =
          next.lastUsed?.params?.length_seconds ?? next.defaults.length_seconds
        setLengthSeconds(
          typeof length === 'number' && Number.isFinite(length)
            ? Number(length)
            : undefined
        )
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pending])

  if (!pending) return null

  const meta = TASK_META[pending.task]
  const isVideo = pending.task === 'text_to_video'
  const hasResolution = (settings?.resolutionOptions.length ?? 0) > 0
  const hasLength = isVideo && (settings?.lengthOptions.length ?? 0) > 0

  const submit = async () => {
    setSubmitting(true)
    const overrides: ChatMediaOverrides = { useLastUsed }
    if (!useLastUsed) {
      if (resolution) overrides.resolution = resolution
      if (isVideo && lengthSeconds !== undefined) {
        overrides.length_seconds = lengthSeconds
      }
    }
    try {
      await onConfirm(pending.task, pending.text, overrides)
      close()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) dismiss()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <meta.Icon size={18} className="text-primary" />
            {t(meta.titleKey, { defaultValue: meta.titleFallback })}
          </DialogTitle>
          <DialogDescription className="line-clamp-2 text-left">
            “{pending.text}”
          </DialogDescription>
        </DialogHeader>

        {!settings && !error ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <IconLoader2 className="animate-spin" size={16} />
            {t('chat:mediaSettings.loading', { defaultValue: 'Reading your settings…' })}
          </div>
        ) : error ? (
          <p className="py-2 text-sm text-destructive">{error}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="media-chat-use-last">
                  {t('chat:mediaSettings.useLastUsed', {
                    defaultValue: 'Use last used settings',
                  })}
                </Label>
                <span className="text-xs text-muted-foreground">
                  {t('chat:mediaSettings.useLastUsedHint', {
                    defaultValue: 'From the Media page, for this kind of media',
                  })}
                </span>
              </div>
              <Switch
                id="media-chat-use-last"
                data-testid="media-chat-use-last"
                checked={useLastUsed}
                onCheckedChange={setUseLastUsed}
              />
            </div>

            {!useLastUsed && hasResolution && (
              <div className="flex flex-col gap-2">
                <Label>
                  {t('chat:mediaSettings.resolution', { defaultValue: 'Resolution' })}
                </Label>
                <RadioGroup
                  value={resolution}
                  onValueChange={setResolution}
                  className="grid grid-cols-2 gap-2"
                  data-testid="media-chat-resolution"
                >
                  {settings!.resolutionOptions.map((option) => {
                    const value = String(option.value)
                    const isHighest = value === settings!.highestResolution
                    const id = `media-chat-res-${value}`
                    return (
                      <Label
                        key={value}
                        htmlFor={id}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-sm',
                          resolution === value && 'border-primary'
                        )}
                      >
                        <RadioGroupItem id={id} value={value} />
                        <span className="flex-1">{resolutionLabel(option)}</span>
                        {isHighest && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            <IconSparkles size={10} />
                            {t('chat:mediaSettings.highest', { defaultValue: 'Highest' })}
                          </span>
                        )}
                      </Label>
                    )
                  })}
                </RadioGroup>
              </div>
            )}

            {!useLastUsed && hasLength && (
              <div className="flex flex-col gap-2">
                <Label>
                  {t('chat:mediaSettings.length', { defaultValue: 'Length' })}
                </Label>
                <RadioGroup
                  value={lengthSeconds === undefined ? '' : String(lengthSeconds)}
                  onValueChange={(value) => setLengthSeconds(Number(value))}
                  className="grid grid-cols-3 gap-2"
                  data-testid="media-chat-length"
                >
                  {settings!.lengthOptions.map((option) => {
                    const value = String(option.value)
                    const id = `media-chat-len-${value}`
                    return (
                      <Label
                        key={value}
                        htmlFor={id}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-sm',
                          String(lengthSeconds) === value && 'border-primary'
                        )}
                      >
                        <RadioGroupItem id={id} value={value} />
                        <span>{optionLabel(option)}</span>
                      </Label>
                    )
                  })}
                </RadioGroup>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={dismiss}
          >
            {t('common:cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            disabled={submitting || Boolean(error) || !settings}
            data-testid="media-chat-generate"
            onClick={submit}
          >
            {submitting ? (
              <IconLoader2 className="animate-spin" size={16} />
            ) : (
              <meta.Icon size={16} />
            )}
            {t('chat:mediaSettings.generate', { defaultValue: 'Generate' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default MediaChatSettingsDialog
