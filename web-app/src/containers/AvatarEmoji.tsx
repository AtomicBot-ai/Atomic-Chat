import React, { memo, useState } from 'react'

import { RobotHeadIcon } from '@/components/icons/robot-head'
import { cn } from '@/lib/utils'

/**
 * Checks if an avatar is a custom image (starts with '/images/')
 */
const isCustomImageAvatar = (avatar: React.ReactNode): avatar is string => {
  return typeof avatar === 'string' && avatar.startsWith('/images/')
}

const isAtomicChatLogoPath = (src: string) =>
  src.includes('atomic-chat-logo') || src.includes('transparent-logo')

/** The first letter or digit of `name`, upper-cased; undefined when it has none. */
const avatarInitial = (name: string | undefined): string | undefined =>
  name
    ?.trim()
    .match(/[\p{L}\p{N}]/u)?.[0]
    ?.toLocaleUpperCase()

/**
 * The size and fill of the initial that stands in for a missing avatar, sized
 * to the 16 px slot the pickers give an avatar image.
 */
const DEFAULT_FALLBACK_CLASS =
  'size-4 rounded-[4px] bg-foreground/10 text-[10px]'

/**
 * Component for rendering assistant avatars with consistent styling
 */
interface AvatarEmojiProps {
  avatar?: React.ReactNode
  /**
   * Whose avatar this is. Its first letter stands in when the avatar is
   * missing, blank or an image that fails to load; a name without a letter
   * gets the assistant glyph. Without a name (or `fallback`) nothing renders.
   */
  name?: string
  imageClassName?: string
  textClassName?: string
  /** Size and fill of the stand-in initial; replaces the 16 px default. */
  fallbackClassName?: string
  /** Rendered instead of the initial when there is no usable avatar. */
  fallback?: React.ReactNode
}

export const AvatarEmoji: React.FC<AvatarEmojiProps> = memo(
  ({
    avatar,
    name,
    imageClassName = 'w-5 h-5 object-contain',
    textClassName = 'text-base',
    fallbackClassName,
    fallback,
  }) => {
    // The image that failed to load, so a new avatar gets its own attempt.
    const [brokenSrc, setBrokenSrc] = useState<string>()
    const blank = typeof avatar === 'string' && avatar.trim() === ''

    if (isCustomImageAvatar(avatar) && brokenSrc !== avatar) {
      return (
        <img
          src={avatar}
          alt="Custom avatar"
          className={cn(
            imageClassName,
            isAtomicChatLogoPath(avatar) && 'dark:brightness-0 dark:invert'
          )}
          onError={() => setBrokenSrc(avatar)}
        />
      )
    }

    if (avatar && !blank && !isCustomImageAvatar(avatar)) {
      return <span className={textClassName}>{avatar}</span>
    }

    // Missing, blank or broken: never an empty tile.
    if (fallback !== undefined) return <>{fallback}</>
    if (name === undefined) return null
    const initial = avatarInitial(name)
    return (
      <span
        aria-hidden="true"
        data-slot="avatar-fallback"
        className={cn(
          'inline-flex shrink-0 items-center justify-center font-semibold leading-none text-muted-foreground select-none',
          fallbackClassName ?? DEFAULT_FALLBACK_CLASS
        )}
      >
        {initial ?? <RobotHeadIcon className="size-3/4" />}
      </span>
    )
  }
)
