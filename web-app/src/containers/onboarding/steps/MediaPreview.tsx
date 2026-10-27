import { useEffect, useRef, useState } from 'react'
import { ImageIcon, Pause, Play, Video } from 'lucide-react'

import { useTranslation } from '@/i18n/react-i18next-compat'

const STILL = '/images/onboarding/robot-studio.webp'
const CLIP = '/images/onboarding/robot-wave.mp4'

/**
 * The top of a media card: the same robot as a still for images and as a
 * short muted loop for video, with the kind named in the corner. The loop
 * plays on its own unless the system asks for reduced motion, and its button
 * pauses and resumes it either way.
 */
export function MediaPreview({ modality }: { modality: 'image' | 'video' }) {
  const { t } = useTranslation()
  const video = useRef<HTMLVideoElement>(null)
  const [paused, setPaused] = useState(true)
  const animated = modality === 'video'

  useEffect(() => {
    if (!animated) return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => {
      if (preference.matches) video.current?.pause()
      else void video.current?.play()?.catch(() => setPaused(true))
    }
    update()
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [animated])

  const toggle = () => {
    const element = video.current
    if (!element) return
    if (element.paused) void element.play().catch(() => setPaused(true))
    else element.pause()
  }

  return (
    <div className="ob-media-scene">
      <span className="ob-media-kind" aria-hidden="true">
        {animated ? <Video size={14} /> : <ImageIcon size={14} />}
        {t(`onboarding-media:art.${modality}`)}
      </span>
      {animated ? (
        <video
          ref={video}
          className="ob-media-art"
          src={CLIP}
          poster={STILL}
          aria-label={t('onboarding-media:preview.videoAlt')}
          muted
          loop
          playsInline
          preload="auto"
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
        />
      ) : (
        <img
          className="ob-media-art"
          src={STILL}
          alt={t('onboarding-media:preview.imageAlt')}
        />
      )}
      {animated && (
        <button
          type="button"
          className="ob-animation-toggle"
          aria-label={t(
            paused ? 'onboarding-media:preview.play' : 'onboarding-media:preview.pause'
          )}
          onClick={toggle}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
      )}
    </div>
  )
}
