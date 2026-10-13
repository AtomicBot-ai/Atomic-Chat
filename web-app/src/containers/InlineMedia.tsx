import { useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Link } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { InlineMediaItem } from '@/lib/inlineMedia'

function InlineMediaTile({ item }: { item: InlineMediaItem }) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState(false)
  const src = convertFileSrc(item.path)

  if (broken) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/40 p-4 text-xs text-muted-foreground">
        {t('chat:media.missing', {
          defaultValue: 'This file is no longer where it was saved.',
        })}
      </div>
    )
  }

  if (item.media_type === 'video') {
    return (
      <video
        data-testid="chat-inline-video"
        className="max-h-[480px] w-full max-w-xl rounded-xl bg-black object-contain"
        src={src}
        controls
        preload="metadata"
        onError={() => setBroken(true)}
      />
    )
  }
  if (item.media_type === 'audio') {
    return (
      <audio
        data-testid="chat-inline-audio"
        className="w-full max-w-xl"
        src={src}
        controls
        onError={() => setBroken(true)}
      />
    )
  }
  return (
    <img
      data-testid="chat-inline-image"
      className="max-h-[480px] max-w-full rounded-xl object-contain"
      src={src}
      alt={item.prompt ?? item.model_label ?? 'Generated image'}
      onError={() => setBroken(true)}
    />
  )
}

/** Generated media shown inside the message that produced it. */
export function InlineMedia({ items }: { items: InlineMediaItem[] }) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="chat-inline-media">
      {items.map((item) => (
        <InlineMediaTile key={item.asset_id} item={item} />
      ))}
      <Link
        to={route.media}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        {t('chat:media.fineTune', {
          defaultValue: 'Fine-tune in Media',
        })}
      </Link>
    </div>
  )
}
