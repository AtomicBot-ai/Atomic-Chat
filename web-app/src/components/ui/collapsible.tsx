import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'

import { cn } from '@/lib/utils'

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      className={cn('cursor-pointer disabled:cursor-default', className)}
      {...props}
    />
  )
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  )
}

/**
 * Height animation for a collapsible panel, opt-in per call site so panels
 * that already animate themselves (the reasoning block) keep their own.
 *
 * Radix measures the panel and publishes its height as a CSS var, which is
 * what these keyframes animate to — a plain height transition can't, since
 * the target is `auto`. `overflow-hidden` keeps the rows clipped while that
 * height is still moving.
 */
const collapsiblePanelAnimation =
  'overflow-hidden duration-300 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down'

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  collapsiblePanelAnimation,
}
