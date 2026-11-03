import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useTranslation } from '@/i18n/react-i18next-compat'

type NavRowProps = {
  to: string
  label: string
  icon?: ReactNode
  active: boolean
  /** Trailing content, e.g. a "New" badge or a status dot. */
  trailing?: ReactNode
  search?: Record<string, unknown>
  testId?: string
}

/** One link row in the contextual sidebar. */
export function NavRow({
  to,
  label,
  icon,
  active,
  trailing,
  search,
  testId,
}: NavRowProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        className="font-medium data-[active=true]:bg-sidebar-foreground/15"
      >
        <Link to={to} search={search as never} data-testid={testId}>
          {icon}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/** A small heading between groups of rows ("Discover", "Workspace"). */
export function NavGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pb-1.5 pt-3.5 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  )
}

/** The blue "New" pill a row carries until its page has been visited. */
export function NewBadge() {
  const { t } = useTranslation()
  return (
    <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
      {t('common:newBadge')}
    </span>
  )
}
