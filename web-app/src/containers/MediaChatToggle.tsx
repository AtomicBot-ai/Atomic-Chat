import { memo } from 'react'
import { IconPhoto, IconVideo } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  useMediaChatMode,
  type ChatMediaTask,
} from '@/stores/media-chat-mode-store'

const MODES: Array<{
  task: ChatMediaTask
  Icon: typeof IconPhoto
  key: string
  fallback: string
}> = [
  {
    task: 'text_to_image',
    Icon: IconPhoto,
    key: 'chat:mediaMode.image',
    fallback: 'Generate an image with your last Media settings',
  },
  {
    task: 'text_to_video',
    Icon: IconVideo,
    key: 'chat:mediaMode.video',
    fallback: 'Generate a video with your last Media settings',
  },
]

/**
 * Switches the composer between asking the model and generating media. Turned
 * on, the next message is sent to the image or video model chosen on the Media
 * page, and the result appears in the conversation.
 */
const MediaChatToggle = memo(function MediaChatToggle({
  className,
}: {
  className?: string
}) {
  const { t } = useTranslation()
  const task = useMediaChatMode((state) => state.task)
  const setTask = useMediaChatMode((state) => state.setTask)

  return (
    <TooltipProvider>
      {MODES.map(({ task: mode, Icon, key, fallback }) => {
        const active = task === mode
        const label = t(key, { defaultValue: fallback })
        return (
          <Tooltip key={mode}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={label}
                aria-pressed={active}
                data-testid={`media-chat-toggle-${mode}`}
                className={cn(
                  'rounded-full text-muted-foreground',
                  active && 'bg-primary/15 text-primary',
                  className
                )}
                onClick={() => setTask(active ? null : mode)}
              >
                <Icon size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{label}</p>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </TooltipProvider>
  )
})

export default MediaChatToggle
