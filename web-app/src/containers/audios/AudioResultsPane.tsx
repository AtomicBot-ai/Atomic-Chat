import { memo, useCallback, useState } from 'react'
import {
  IconFolderOpen,
  IconInfoCircle,
  IconMicrophone,
  IconMusic,
  IconTrash,
  IconWaveSine,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { AudioPlayer } from '@/containers/AudioPlayer'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { audioAttributionOf } from '@/lib/audio/models'
import { cn } from '@/lib/utils'
import type { AudioGalleryItem } from '@/services/audio/types'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

import { AudioJobStatus } from './AudioJobStatus'
import { AudioAttribution } from './AudioModelPicker'
import { DeleteAudioClipDialog } from './DeleteAudioClipDialog'
import { useAudioClipSrc } from './useAudioClipSrc'

const MODE_ICONS = {
  speech: IconMicrophone,
  music: IconMusic,
  effects: IconWaveSine,
}

function Waveform({ active }: { active: boolean }) {
  return (
    <div className={cn('audio-waveform', active && 'is-playing')} aria-hidden>
      {Array.from({ length: 56 }, (_, i) => (
        <i
          key={i}
          style={{
            height: `${14 + Math.abs(Math.sin(i * 0.61) * Math.cos(i * 0.19)) * 85}%`,
            animationDelay: `${i * -0.037}s`,
          }}
        />
      ))}
    </div>
  )
}

/** The facts a clip reports: formats differ by model, so none is assumed. */
function useClipFacts(item: AudioGalleryItem): string {
  const { t } = useTranslation()
  return [
    t('audios:viewer.seconds', {
      seconds: (item.audioMs / 1000).toFixed(1),
    }),
    t('audios:viewer.sampleRate', { rate: item.sampleRate / 1000 }),
    t(
      item.channels === 1
        ? 'audios:viewer.mono'
        : item.channels === 2
          ? 'audios:viewer.stereo'
          : 'audios:viewer.channels',
      { count: item.channels }
    ),
    'WAV',
  ].join(' · ')
}

const AudioViewer = memo(function AudioViewer({
  item,
  onDelete,
}: {
  item: AudioGalleryItem
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const src = useAudioClipSrc(item.path)
  const [playing, setPlaying] = useState(false)
  const loop = useAudioGenerationStore(
    (state) => state.forms[item.recipe.mode].loop
  )
  const attribution = useAudioGenerationStore((state) =>
    audioAttributionOf(state.catalog, item.recipe.model.modelId)
  )
  const facts = useClipFacts(item)
  const { recipe } = item

  const reveal = useCallback(async () => {
    try {
      await serviceHub.opener().revealItemInDir(item.path)
    } catch (error) {
      toast.error(t('audios:viewer.showFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [item.path, serviceHub, t])

  return (
    <div
      className="group/viewer @container grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-2 overflow-hidden px-6 pt-4 pb-2"
      data-testid="audio-viewer"
    >
      <div className="relative flex min-h-0 min-w-0 items-start justify-center overflow-hidden [container-type:size]">
        <div
          className="relative flex shrink-0 flex-col items-center justify-center gap-4 overflow-hidden rounded-lg bg-secondary/30 px-5 shadow-md"
          style={{
            width: 'min(100cqw, 150cqh)',
            height: 'min(100cqh, 66.667cqw)',
          }}
        >
          <Waveform active={playing} />
          {src && (
            <AudioPlayer
              key={item.id}
              src={src}
              mediaType="audio/wav"
              loop={loop}
              onPlayingChange={setPlaying}
              className="w-full"
            />
          )}
          <AudioAttribution text={attribution} />
        </div>
      </div>
      <div className="flex min-w-0 items-center justify-center gap-0.5 [&_button>span]:hidden @[32rem]:[&_button>span]:inline">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('audios:viewer.details')}
            >
              <IconInfoCircle size={16} />
              <span>{t('audios:viewer.details')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="max-h-72 space-y-3 overflow-y-auto text-sm">
            <div className="space-y-1">
              <p className="font-medium">{recipe.model.displayName}</p>
              <AudioAttribution text={attribution} />
            </div>
            <p className="whitespace-pre-wrap">{recipe.text}</p>
            {recipe.lyrics && (
              <p className="whitespace-pre-wrap text-muted-foreground">
                {recipe.lyrics}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {[
                facts,
                recipe.voice &&
                  t('audios:viewer.voice', { voice: recipe.voice }),
                t('audios:viewer.seed', { seed: recipe.seed }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('audios:viewer.showInFolder')}
          onClick={() => void reveal()}
        >
          <IconFolderOpen size={16} />
          <span>{t('audios:viewer.showInFolder')}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('audios:viewer.deleteClip', { prompt: recipe.text })}
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <IconTrash size={16} />
          <span>{t('audios:viewer.delete')}</span>
        </Button>
      </div>
    </div>
  )
})

/**
 * The pane right of the form: the job's state or the selected clip over the
 * gallery the core keeps. A reload lists the same clips, because they live on
 * disk beside their recipes; nothing here is the page's own.
 */
export const AudioResultsPane = memo(function AudioResultsPane() {
  const { t } = useTranslation()
  const gallery = useAudioGenerationStore((state) => state.gallery)
  const total = useAudioGenerationStore((state) => state.galleryTotal)
  const hasMore = useAudioGenerationStore((state) => state.galleryHasMore)
  const selectedId = useAudioGenerationStore((state) => state.selectedId)
  const selectClip = useAudioGenerationStore((state) => state.selectClip)
  const loadMore = useAudioGenerationStore((state) => state.loadMoreGallery)
  const busy = useAudioGenerationStore(
    (state) => state.generating || state.loadingModelId !== null
  )
  const [deleting, setDeleting] = useState<string | null>(null)
  const selected = gallery.find((clip) => clip.id === selectedId) ?? null

  return (
    <>
      <div
        className="min-h-0 min-w-0 flex-[3] overflow-hidden"
        data-testid="audio-viewer-section"
      >
        {busy ? (
          <AudioJobStatus variant="pane" />
        ) : (
          selected && (
            <AudioViewer
              key={selected.id}
              item={selected}
              onDelete={() => setDeleting(selected.id)}
            />
          )
        )}
      </div>
      <div className="flex min-h-0 flex-[2] flex-col border-t border-border/60">
        <div className="flex shrink-0 items-center gap-2 px-6 py-2 text-xs text-muted-foreground">
          <IconWaveSine size={14} />
          <span>{t('audios:gallery.title')}</span>
          <span className="tabular-nums">{total}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2"
            data-testid="audio-gallery-grid"
          >
            {gallery.map((clip) => {
              const Icon = MODE_ICONS[clip.recipe.mode]
              return (
                <button
                  type="button"
                  key={clip.id}
                  className={cn(
                    'group relative min-w-0 overflow-hidden rounded-lg border bg-secondary/30 outline-none hover:ring-2 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring',
                    selectedId === clip.id && 'ring-2 ring-primary'
                  )}
                  style={{ aspectRatio: '3/2' }}
                  aria-label={t('audios:gallery.open', {
                    prompt: clip.recipe.text,
                  })}
                  aria-pressed={selectedId === clip.id}
                  onClick={() => selectClip(clip.id)}
                >
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    <Icon size={28} />
                  </div>
                  <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-2 py-1 text-left text-[10px]">
                    {clip.recipe.text}
                  </span>
                </button>
              )
            })}
          </div>
          {hasMore && (
            <div className="flex justify-center pt-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void loadMore()}
              >
                {t('audios:gallery.loadMore')}
              </Button>
            </div>
          )}
        </div>
      </div>
      <DeleteAudioClipDialog id={deleting} onClose={() => setDeleting(null)} />
    </>
  )
})
