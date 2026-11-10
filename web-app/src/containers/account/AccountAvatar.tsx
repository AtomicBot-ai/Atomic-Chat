import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { accountInitials } from '@/lib/account'
import { cn } from '@/lib/utils'
import type { AccountUser } from '@/services/account/types'

/** The account's picture, or its initials until (or unless) the picture loads. */
export function AccountAvatar({
  user,
  className,
  fallbackClassName,
}: {
  user: AccountUser
  className?: string
  fallbackClassName?: string
}) {
  return (
    <Avatar className={className} data-testid="account-avatar">
      {user.avatarUrl && (
        <AvatarImage
          src={user.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="object-cover"
        />
      )}
      <AvatarFallback
        className={cn(
          'bg-foreground/10 font-medium text-foreground select-none',
          fallbackClassName
        )}
      >
        {accountInitials(user)}
      </AvatarFallback>
    </Avatar>
  )
}
