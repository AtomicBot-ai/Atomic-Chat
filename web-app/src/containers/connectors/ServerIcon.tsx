import type { MCPConnector } from '@/constants/mcp-connectors'
import { ConnectorIcon } from '@/containers/connectors/ConnectorIcon'
import { cn } from '@/lib/utils'

/** Brand tile for catalog connectors, monogram for anything hand-added. */
export function ServerIcon({
  connector,
  name,
  className,
}: {
  connector?: MCPConnector
  name: string
  className?: string
}) {
  if (connector) {
    return <ConnectorIcon connector={connector} className={className} />
  }
  return (
    <div
      className={cn(
        'flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted',
        className
      )}
    >
      <span className="text-sm font-semibold uppercase text-muted-foreground">
        {name.charAt(0)}
      </span>
    </div>
  )
}
