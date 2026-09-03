import type { MCPConnector } from '@/constants/mcp-connectors'
import { cn } from '@/lib/utils'

/**
 * Brand tile for a catalog connector: image asset when one exists, otherwise a
 * monogram on the connector's brand color. 32px on the Connectors page, smaller
 * where it sits in a menu row — pass `className` to size it.
 */
export function ConnectorIcon({
  connector,
  className,
}: {
  connector: MCPConnector
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md',
        className
      )}
      style={{ backgroundColor: connector.icon.bg }}
    >
      {connector.icon.src ? (
        <img
          src={connector.icon.src}
          alt={connector.name}
          className="size-full object-contain"
        />
      ) : (
        <span className="text-sm font-semibold text-white">
          {connector.name.charAt(0)}
        </span>
      )}
    </div>
  )
}
